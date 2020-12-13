/**
 * ssh2 sftp client for node
 */

'use strict';

const {Client} = require('ssh2');
const fs = require('fs');
const concat = require('concat-stream');
//const retry = require('retry');
const promiseRetry = require('promise-retry');
const {join, parse} = require('path');
const utils = require('./utils');
const {errorCode} = require('./constants');

class SftpClient {
  constructor(clientName) {
    this.client = new Client();
    this.sftp = undefined;
    this.clientName = clientName ? clientName : 'sftp';
    this.endCalled = false;
    this.errorHandled = false;
    this.remotePathSep = '/';
    this.remotePlatform = 'unix';
    this.debug = undefined;

    this.client.on('close', () => {
      if (!this.endCalled) {
        this.debugMsg('Unexpected close event raised by server');
        this.sftp = undefined;
      }
    });
    this.client.on('end', () => {
      if (!this.endCalled) {
        this.debugMsg('Unexpected end event raised by server');
        this.sftp = undefined;
      }
    });
    this.client.on('error', (err) => {
      if (!this.errorHandled) {
        throw utils.formatError(
          `Unexpected error: ${err.message}`,
          'global-error-handler',
          err.code
        );
      } else {
        this.errorHandled = false;
      }
    });
  }

  debugMsg(msg, obj) {
    if (this.debug) {
      if (obj) {
        this.debug(
          `CLIENT[${this.clientName}]: ${msg} ${JSON.stringify(obj, null, ' ')}`
        );
      } else {
        this.debug(`CLIENT[${this.clientName}]: ${msg}`);
      }
    }
  }

  /**
   * Add a listner to the client object. This is rarely necessary and can be
   * the source of errors. It is the client's responsibility to remove the
   * listeners when no longer required. Failure to do so can result in memory
   * leaks.
   *
   * @param {string} eventType - one of the supported event types
   * @param {function} callback - function called when event triggers
   */
  on(eventType, callback) {
    this.debugMsg(`Adding listener to ${eventType}`);
    this.client.on(eventType, callback);
  }

  removeListener(eventType, callback) {
    this.debugMsg(`Removing listener from ${eventType}`);
    this.client.removeListener(eventType, callback);
  }

  /**
   * @async
   *
   * Create a new SFTP connection to a remote SFTP server
   *
   * @param {Object} config - an SFTP configuration object
   * @param {string} connectMethod - ???
   *
   * @return {Promise} which will resolve to an sftp client object
   *
   */
  sftpConnect(config) {
    return new Promise((resolve, reject) => {
      let connectReady = () => {
        this.client.sftp((err, sftp) => {
          if (err) {
            this.debugMsg(`SFTP channel error: ${err.message} ${err.code}`);
            reject(utils.formatError(err, 'sftpConnect', err.code));
          } else {
            //this.sftp = sftp;
            resolve(sftp);
          }
          this.client.removeListener('ready', connectReady);
        });
      };
      utils.addTempListeners(this, 'sftpConnect', reject);
      this.client.on('ready', connectReady).connect(config);
    });
  }

  retryConnect(config) {
    return promiseRetry(
      (retry, attempt) => {
        this.debugMsg(`Connect attempt ${attempt}`);
        return this.sftpConnect(config).catch((err) => {
          utils.removeTempListeners(this.client);
          retry(err);
        });
      },
      {
        retries: config.retries || 1,
        factor: config.retry_factor || 2,
        minTimeout: config.retry_minTimeout || 1000
      }
    );
  }

  async connect(config) {
    try {
      if (config.debug) {
        this.debug = config.debug;
        this.debugMsg('Debugging turned on');
      }
      if (this.sftp) {
        this.debugMsg('Already connected - reject');
        throw utils.formatError(
          'An existing SFTP connection is already defined',
          'connect',
          errorCode.connect
        );
      }
      //this.sftp = await this.sftpConnect(config);
      this.sftp = await this.retryConnect(config);
      this.debugMsg('SFTP Connection established');
      utils.removeTempListeners(this.client);
    } catch (err) {
      throw utils.formatError(err.message, 'connect', err.errorCode);
    }
  }

  /**
   * @async
   *
   * Returns the real absolute path on the remote server. Is able to handle
   * both '.' and '..' in path names, but not '~'. If the path is relative
   * then the current working directory is prepended to create an absolute path.
   * Returns undefined if the
   * path does not exists.
   *
   * @param {String} remotePath - remote path, may be relative
   * @returns {}
   */
  realPath(remotePath) {
    return new Promise((resolve, reject) => {
      this.debugMsg(`realPath -> ${remotePath}`);
      utils.addTempListeners(this, 'realPath', reject);
      if (utils.haveConnection(this, 'realPath', reject)) {
        this.sftp.realpath(remotePath, (err, absPath) => {
          if (err) {
            this.debugMsg(`realPath Error: ${err.message} Code: ${err.code}`);
            if (err.code === 2) {
              resolve('');
            } else {
              reject(
                utils.formatError(
                  `${err.message} ${remotePath}`,
                  'realPath',
                  err.code
                )
              );
            }
          }
          this.debugMsg(`realPath <- ${absPath}`);
          resolve(absPath);
          utils.removeTempListeners(this.client);
        });
      }
    });
  }

  cwd() {
    return this.realPath('.');
  }

  /**
   * Retrieves attributes for path
   *
   * @param {String} path, a string containing the path to a file
   * @return {Promise} stats, attributes info
   */
  async stat(remotePath) {
    const _stat = (aPath) => {
      return new Promise((resolve, reject) => {
        this.debugMsg(`stat -> ${aPath}`);
        utils.addTempListeners(this, 'stat', reject);
        this.sftp.stat(aPath, (err, stats) => {
          if (err) {
            this.debugMsg(`stat error ${err.message} code: ${err.code}`);
            if (err.code === 2 || err.code === 4) {
              reject(
                utils.formatError(
                  `No such file: ${remotePath}`,
                  '_stat',
                  errorCode.notexist
                )
              );
            } else {
              reject(
                utils.formatError(
                  `${err.message} ${remotePath}`,
                  '_stat',
                  err.code
                )
              );
            }
          } else {
            this.debugMsg('stats <- ', stats);
            resolve({
              mode: stats.mode,
              uid: stats.uid,
              gid: stats.gid,
              size: stats.size,
              accessTime: stats.atime * 1000,
              modifyTime: stats.mtime * 1000,
              isDirectory: stats.isDirectory(),
              isFile: stats.isFile(),
              isBlockDevice: stats.isBlockDevice(),
              isCharacterDevice: stats.isCharacterDevice(),
              isSymbolicLink: stats.isSymbolicLink(),
              isFIFO: stats.isFIFO(),
              isSocket: stats.isSocket()
            });
          }
          utils.removeTempListeners(this.client);
        });
      });
    };

    try {
      utils.haveConnection(this, 'stat');
      let absPath = await utils.normalizeRemotePath(this, remotePath);
      return _stat(absPath);
    } catch (err) {
      return utils.handleError(err, 'stat');
    }
  }

  /**
   * @async
   *
   * Tests to see if an object exists. If it does, return the type of that object
   * (in the format returned by list). If it does not exist, return false.
   *
   * @param {string} path - path to the object on the sftp server.
   *
   * @return {boolean} returns false if object does not exist. Returns type of
   *                   object if it does
   */
  async exists(remotePath) {
    try {
      if (utils.haveConnection(this, 'exists')) {
        if (remotePath === '.') {
          return 'd';
        }
        let absPath = await utils.normalizeRemotePath(this, remotePath);
        try {
          this.debugMsg(`exists -> ${absPath}`);
          let info = await this.stat(absPath);
          this.debugMsg('exists <- ', info);
          if (info.isDirectory) {
            return 'd';
          }
          if (info.isSymbolicLink) {
            return 'l';
          }
          if (info.isFile) {
            return '-';
          }
          return false;
        } catch (err) {
          if (err.code === errorCode.notexist) {
            return false;
          }
          throw err;
        }
      } else {
        return false;
      }
    } catch (err) {
      return utils.handleError(err, 'exists');
    }
  }

  /**
   * @async
   *
   * List contents of a remote directory. If a pattern is provided,
   * filter the results to only include files with names that match
   * the supplied pattern. Return value is an array of file entry
   * objects that include properties for type, name, size, modifiyTime,
   * accessTime, rights {user, group other}, owner and group.
   *
   * @param {String} remotePath - path to remote directory
   * @param {RegExp} pattern - regular expression to match filenames
   * @returns {Array} file description objects
   * @throws {Error}
   */
  list(remotePath, pattern = /.*/) {
    return new Promise((resolve, reject) => {
      if (utils.haveConnection(this, 'list', reject)) {
        const reg = /-/gi;
        this.debugMsg(`list -> ${remotePath} filter -> ${pattern}`);
        utils.addTempListeners(this, 'list', reject);
        this.sftp.readdir(remotePath, (err, fileList) => {
          if (err) {
            this.debugMsg(`list error ${err.message} code: ${err.code}`);
            reject(
              utils.formatError(
                `${err.message} ${remotePath}`,
                'list',
                err.code
              )
            );
          } else {
            this.debugMsg('list <- ', fileList);
            let newList = [];
            // reset file info
            if (fileList) {
              newList = fileList.map((item) => {
                return {
                  type: item.longname.substr(0, 1),
                  name: item.filename,
                  size: item.attrs.size,
                  modifyTime: item.attrs.mtime * 1000,
                  accessTime: item.attrs.atime * 1000,
                  rights: {
                    user: item.longname.substr(1, 3).replace(reg, ''),
                    group: item.longname.substr(4, 3).replace(reg, ''),
                    other: item.longname.substr(7, 3).replace(reg, '')
                  },
                  owner: item.attrs.uid,
                  group: item.attrs.gid
                };
              });
            }
            // provide some compatibility for auxList
            let regex;
            if (pattern instanceof RegExp) {
              regex = pattern;
            } else {
              let newPattern = pattern.replace(/\*([^*])*?/gi, '.*');
              regex = new RegExp(newPattern);
            }
            resolve(newList.filter((item) => regex.test(item.name)));
          }
          utils.removeTempListeners(this.client);
        });
      }
    });
  }

  /**
   * get file
   *
   * If a dst argument is provided, it must be either a string, representing the
   * local path to where the data will be put, a stream, in which case data is
   * piped into the stream or undefined, in which case the data is returned as
   * a Buffer object.
   *
   * @param {String} path, remote file path
   * @param {string|stream|undefined} dst, data destination
   * @param {Object} userOptions, options passed to get
   *
   * @return {Promise}
   */
  get(remotePath, dst, options = {}) {
    return new Promise((resolve, reject) => {
      if (utils.haveConnection(this, 'get', reject)) {
        this.debugMsg(`get -> ${remotePath} `, options);
        utils.addTempListeners(this, 'get', reject);
        let rdr = this.sftp.createReadStream(remotePath, options);
        rdr.once('error', (err) => {
          utils.removeListeners(rdr);
          reject(
            utils.formatError(`${err.message} ${remotePath}`, 'get', err.code)
          );
          utils.removeTempListeners(this.client);
        });
        if (dst === undefined) {
          // no dst specified, return buffer of data
          this.debugMsg('get returning buffer of data');
          let concatStream = concat((buff) => {
            rdr.removeAllListeners('error');
            resolve(buff);
            utils.removeTempListeners(this.client);
          });
          rdr.pipe(concatStream);
        } else {
          let wtr;
          if (typeof dst === 'string') {
            // dst local file path
            this.debugMsg('get returning local file');
            wtr = fs.createWriteStream(dst);
          } else {
            this.debugMsg('get returning data into supplied stream');
            wtr = dst;
          }
          wtr.once('error', (err) => {
            utils.removeListeners(rdr);
            reject(
              utils.formatError(
                `${err.message} ${typeof dst === 'string' ? dst : ''}`,
                'get',
                err.code
              )
            );
            if (options.autoClose === false) {
              rdr.destroy();
            }
            utils.removeTempListeners(this.client);
          });
          wtr.once('finish', () => {
            utils.removeListeners(rdr);
            if (options.autoClose === false) {
              rdr.destroy();
            }
            if (typeof dst === 'string') {
              resolve(dst);
            } else {
              resolve(wtr);
            }
            utils.removeTempListeners(this.client);
          });
          rdr.pipe(wtr);
        }
      }
    });
  }

  /**
   * Use SSH2 fastGet for downloading the file.
   * Downloads a file at remotePath to localPath using parallel reads
   * for faster throughput.
   *
   * See 'fastGet' at
   * https://github.com/mscdex/ssh2-streams/blob/master/SFTPStream.md
   *
   * @param {String} remotePath
   * @param {String} localPath
   * @param {Object} options
   * @return {Promise} the result of downloading the file
   */
  fastGet(remotePath, localPath, options) {
    return this.exists(remotePath)
      .then((ftype) => {
        if (ftype !== '-') {
          let msg =
            ftype === false
              ? `No such file ${remotePath}`
              : `Not a regular file ${remotePath}`;
          return Promise.reject(
            utils.formatError(msg, 'fastGet', errorCode.badPath)
          );
        }
      })
      .then(() => {
        return new Promise((resolve, reject) => {
          if (utils.haveConnection(this, 'fastGet', reject)) {
            this.debugMsg(
              `fastGet -> remote: ${remotePath} local: ${localPath} `,
              options
            );
            utils.addTempListeners(this, 'fastGet', reject);
            this.sftp.fastGet(remotePath, localPath, options, (err) => {
              if (err) {
                this.debugMsg(`fastGet error ${err.message} code: ${err.code}`);
                reject(utils.formatError(err, 'fastGet'));
              }
              resolve(
                `${remotePath} was successfully download to ${localPath}!`
              );
              utils.removeTempListeners(this.client);
            });
          }
        });
      });
  }

  /**
   * Use SSH2 fastPut for uploading the file.
   * Uploads a file from localPath to remotePath using parallel reads
   * for faster throughput.
   *
   * See 'fastPut' at
   * https://github.com/mscdex/ssh2-streams/blob/master/SFTPStream.md
   *
   * @param {String} localPath
   * @param {String} remotePath
   * @param {Object} options
   * @return {Promise} the result of downloading the file
   */
  fastPut(localPath, remotePath, options) {
    this.debugMsg(`fastPut -> local ${localPath} remote ${remotePath}`);
    return utils
      .localExists(localPath)
      .then((localStatus) => {
        this.debugMsg(`fastPut <- localStatus ${localStatus}`);
        if (localStatus !== '-') {
          this.debugMsg('fastPut reject bad source path');
          return Promise.reject(
            utils.formatError(
              `Bad path ${localPath}`,
              'fastPut',
              errorCode.badPath
            )
          );
        }
        return new Promise((resolve, reject) => {
          fs.access(localPath, fs.constants.F_OK | fs.constants.R_OK, (err) => {
            if (err) {
              this.debugMsg('fastPut reject no access source');
              reject(
                utils.formatError(
                  `${err.message} ${localPath}`,
                  'fastPut',
                  err.code
                )
              );
            } else {
              this.debugMsg('fastPut source access ok');
              resolve(true);
            }
          });
        });
      })
      .then(() => {
        return new Promise((resolve, reject) => {
          if (utils.haveConnection(this, 'fastPut', reject)) {
            this.debugMsg(
              `fastPut -> local: ${localPath} remote: ${remotePath} opts: ${JSON.stringify(
                options
              )}`
            );
            utils.addTempListeners(this, 'fastPut', reject);
            this.sftp.fastPut(localPath, remotePath, options, (err) => {
              if (err) {
                this.debugMsg(`fastPut error ${err.message} ${err.code}`);
                reject(
                  utils.formatError(
                    `${err.message} Local: ${localPath} Remote: ${remotePath}`,
                    'fastPut',
                    err.code
                  )
                );
              }
              this.debugMsg('fastPut file transferred');
              resolve(
                `${localPath} was successfully uploaded to ${remotePath}!`
              );
            });
          }
        });
      })
      .then((msg) => {
        utils.removeTempListeners(this.client);
        return msg;
      });
  }

  /**
   * Create a file on the remote server. The 'src' argument
   * can be a buffer, string or read stream. If 'src' is a string, it
   * should be the path to a local file.
   *
   * @param  {String|Buffer|stream} src - source data to use
   * @param  {String} remotePath - path to remote file
   * @param  {Object} options - options used for write stream configuration
   *                            value supported by node streams.
   * @return {Promise}
   */
  put(localSrc, remotePath, options = {}) {
    this.debugMsg(
      `put ${
        typeof localSrc === 'string' ? localSrc : '<buffer | stream>'
      } -> ${remotePath}`,
      options
    );
    return utils
      .localExists(typeof localSrc === 'string' ? localSrc : 'dummy')
      .then((localStatus) => {
        if (typeof localSrc === 'string' && localStatus !== '-') {
          this.debugMsg(`put: file does not exist ${localSrc} - rejecting`);
          return Promise.reject(
            utils.formatError(`Bad path ${localSrc}`, 'put', errorCode.badPath)
          );
        }
        return new Promise((resolve, reject) => {
          if (typeof localSrc === 'string') {
            fs.access(
              localSrc,
              fs.constants.F_OK | fs.constants.R_OK,
              (err) => {
                if (err) {
                  this.debugMsg(`put: Cannot read ${localSrc} - rejecting`);
                  reject(
                    utils.formatError(
                      `Permission denied ${localSrc}`,
                      'put',
                      errorCode.permission
                    )
                  );
                } else {
                  this.debugMsg('put: localSrc file OK');
                  resolve(true);
                }
              }
            );
          } else {
            this.debugMsg('put: localSrc buffer or string OK');
            resolve(true);
          }
        });
      })
      .then(() => {
        return new Promise((resolve, reject) => {
          if (utils.haveConnection(this, 'put', reject)) {
            utils.addTempListeners(this, 'put', reject);
            let stream = this.sftp.createWriteStream(remotePath, options);
            stream.once('error', (err) => {
              reject(
                utils.formatError(
                  `${err.message} ${remotePath}`,
                  'put',
                  err.code
                )
              );
              utils.removeTempListeners(this.client);
            });
            stream.once('finish', () => {
              utils.removeListeners(stream);
              if (options.autoClose === false) {
                stream.destroy();
              }
              resolve(`Uploaded data stream to ${remotePath}`);
              utils.removeTempListeners(this.client);
            });
            if (localSrc instanceof Buffer) {
              this.debugMsg('put source is a buffer');
              stream.end(localSrc);
            } else {
              let rdr;
              if (typeof localSrc === 'string') {
                this.debugMsg(`put source is a file path: ${localSrc}`);
                rdr = fs.createReadStream(localSrc);
              } else {
                this.debugMsg('put source is a stream');
                rdr = localSrc;
              }
              rdr.once('error', (err) => {
                utils.removeListeners(stream);
                reject(
                  utils.formatError(
                    `${err.message} ${
                      typeof localSrc === 'string' ? localSrc : ''
                    }`,
                    'put',
                    err.code
                  )
                );
                if (options.autoClose === false) {
                  stream.destroy();
                }
                utils.removeTempListeners(this.client);
              });
              rdr.pipe(stream);
            }
          }
        });
      });
  }

  /**
   * Append to an existing remote file
   *
   * @param  {Buffer|stream} input
   * @param  {String} remotePath,
   * @param  {Object} options
   * @return {Promise}
   */
  append(input, remotePath, options = {}) {
    return new Promise((resolve, reject) => {
      if (utils.haveConnection(this, 'append', reject)) {
        if (typeof input === 'string') {
          reject(
            utils.formatError('Cannot append one file to another', 'append')
          );
        } else {
          this.debugMsg(`append -> remote: ${remotePath} `, options);
          utils.addTempListeners(this, 'append', reject);
          options.flags = 'a';
          let stream = this.sftp.createWriteStream(remotePath, options);
          stream.once('error', (err) => {
            utils.removeListeners(stream);
            reject(
              utils.formatError(
                `${err.message} ${remotePath}`,
                'append',
                err.code
              )
            );
            utils.removeTempListeners(this.client);
          });
          stream.once('finish', () => {
            utils.removeListeners(stream);
            resolve(`Appended data to ${remotePath}`);
            utils.removeTempListeners(this.client);
          });
          if (input instanceof Buffer) {
            stream.end(input);
          } else {
            input.pipe(stream);
          }
        }
      }
    });
  }

  /**
   * @async
   *
   * Make a directory on remote server
   *
   * @param {string} path, remote directory path.
   * @param {boolean} recursive, if true, recursively create directories
   * @return {Promise}.
   */
  async mkdir(remotePath, recursive = false) {
    const _mkdir = (p) => {
      return new Promise((resolve, reject) => {
        this.debugMsg(`mkdir -> ${p}`);
        utils.addTempListeners(this, 'mkdir', reject);
        this.sftp.mkdir(p, (err) => {
          if (err) {
            this.debugMsg(`mkdir error ${err.message} code: ${err.code}`);
            reject(
              utils.formatError(`${err.message} ${p}`, '_mkdir', err.code)
            );
          }
          resolve(`${p} directory created`);
          utils.removeTempListeners(this.client);
        });
      });
    };

    try {
      utils.haveConnection(this, 'mkdir');
      let rPath = await utils.normalizeRemotePath(this, remotePath);
      if (!recursive) {
        return _mkdir(rPath);
      }
      let dir = parse(rPath).dir;
      if (dir) {
        let dirExists = await this.exists(dir);
        if (!dirExists) {
          await this.mkdir(dir, true);
        }
      }
      return _mkdir(rPath);
    } catch (err) {
      return utils.handleError(`${err.message} ${remotePath}`, 'mkdir');
    }
  }

  /**
   * @async
   *
   * Remove directory on remote server
   *
   * @param {string} path, path to directory to be removed
   * @param {boolean} recursive, if true, remove directories/files in target
   *                             directory
   * @return {Promise}..
   */
  async rmdir(remotePath, recursive = false) {
    const _rmdir = (p) => {
      return new Promise((resolve, reject) => {
        this.debugMsg(`rmdir -> ${p}`);
        utils.addTempListeners(this, 'rmdir', reject);
        this.sftp.rmdir(p, (err) => {
          if (err) {
            this.debugMsg(`rmdir error ${err.message} code: ${err.code}`);
            reject(
              utils.formatError(`${err.message} ${p}`, '_rmdir', err.code)
            );
          }
          resolve('Successfully removed directory');
          utils.removeTempListeners(this.client);
        });
      });
    };

    try {
      utils.haveConnection(this, 'rmdir');
      let absPath = await utils.normalizeRemotePath(this, remotePath);
      if (!recursive) {
        return _rmdir(absPath);
      }
      let list = await this.list(absPath);
      if (list.length) {
        let files = list.filter((item) => item.type !== 'd');
        let dirs = list.filter((item) => item.type === 'd');
        this.debugMsg('rmdir contents (files): ', files);
        this.debugMsg('rmdir contents (dirs): ', dirs);
        for (let f of files) {
          await this.delete(`${absPath}${this.remotePathSep}${f.name}`);
        }
        for (let d of dirs) {
          await this.rmdir(`${absPath}${this.remotePathSep}${d.name}`, true);
        }
      }
      return _rmdir(absPath);
    } catch (err) {
      return utils.handleError(err, 'rmdir');
    }
  }

  /**
   * @async
   *
   * Delete a file on the remote SFTP server
   *
   * @param {string} path - path to the file to delete
   * @param {boolean} notFoundOK - if true, ignore errors for missing target.
   *                               Default is false.
   * @return {Promise} with string 'Successfully deleeted file' once resolved
   *
   */
  delete(remotePath, notFoundOK = false) {
    return new Promise((resolve, reject) => {
      if (utils.haveConnection(this, 'delete', reject)) {
        this.debugMsg(`delete -> ${remotePath}`);
        utils.addTempListeners(this, 'delete', reject);
        this.sftp.unlink(remotePath, (err) => {
          if (err) {
            this.debugMsg(`delete error ${err.message} code: ${err.code}`);
            if (notFoundOK && err.code === 2) {
              this.debugMsg('delete ignore missing target error');
              resolve(`Successfully deleted ${remotePath}`);
            } else {
              reject(
                utils.formatError(
                  `${err.message} ${remotePath}`,
                  'delete',
                  err.code
                )
              );
            }
          }
          resolve(`Successfully deleted ${remotePath}`);
          utils.removeTempListeners(this.client);
        });
      }
    });
  }

  /**
   * @async
   *
   * Rename a file on the remote SFTP repository
   *
   * @param {string} fromPath - path to the file to be renamed.
   * @param {string} toPath - path to the new name.
   *
   * @return {Promise}
   *
   */
  rename(fromPath, toPath) {
    return new Promise((resolve, reject) => {
      if (utils.haveConnection(this, 'rename', reject)) {
        this.debugMsg(`rename -> ${fromPath} ${toPath}`);
        utils.addTempListeners(this, 'rename', reject);
        this.sftp.rename(fromPath, toPath, (err) => {
          if (err) {
            this.debugMsg(`rename error ${err.message} code: ${err.code}`);
            reject(
              utils.formatError(
                `${err.message} From: ${fromPath} To: ${toPath}`,
                'rename',
                err.code
              )
            );
          }
          resolve(`Successfully renamed ${fromPath} to ${toPath}`);
          utils.removeTempListeners(this.client);
        });
      }
    });
  }

  /**
   * @async
   *
   * Rename a file on the remote SFTP repository using the SSH extension
   * posix-rename@openssh.com using POSIX atomic rename. (Introduced in SSH 4.8)
   *
   * @param {string} fromPath - path to the file to be renamed.
   * @param {string} toPath - path to the new name.
   *
   * @return {Promise}
   *
   */
  posixRename(fromPath, toPath) {
    return new Promise((resolve, reject) => {
      if (utils.haveConnection(this, 'posixRename', reject)) {
        this.debugMsg(`posixRename -> ${fromPath} ${toPath}`);
        utils.addTempListeners(this, 'posixRename', reject);
        this.sftp.ext_openssh_rename(fromPath, toPath, (err) => {
          if (err) {
            this.debugMsg(`posixRename error ${err.message} code: ${err.code}`);
            reject(
              utils.formatError(
                `${err.message} From: ${fromPath} To: ${toPath}`,
                'posixRename',
                err.code
              )
            );
          }
          resolve(`Successful POSIX rename ${fromPath} to ${toPath}`);
          utils.removeTempListeners(this.client);
        });
      }
    });
  }

  /**
   * @async
   *
   * Change the mode of a remote file on the SFTP repository
   *
   * @param {string} remotePath - path to the remote target object.
   * @param {Octal} mode - the new mode to set
   *
   * @return {Promise}.
   */
  chmod(remotePath, mode) {
    return new Promise((resolve, reject) => {
      this.debugMsg(`chmod -> ${remotePath} ${mode}`);
      utils.addTempListeners(this, 'chmod', reject);
      this.sftp.chmod(remotePath, mode, (err) => {
        if (err) {
          reject(
            utils.formatError(`${err.message} ${remotePath}`, 'chmod', err.code)
          );
        }
        resolve('Successfully change file mode');
        utils.removeTempListeners(this.client);
      });
    });
  }

  /**
   * @async
   *
   * Upload the specified source directory to the specified destination
   * directory. All regular files and sub-directories are uploaded to the remote
   * server.
   * @param {String} srcDir - local source directory
   * @param {String} dstDir - remote destination directory
   * @returns {String}
   * @throws {Error}
   */
  async uploadDir(srcDir, dstDir, filter = /.*/) {
    try {
      this.debugMsg(`uploadDir -> ${srcDir} ${dstDir}`);
      utils.haveConnection(this, 'uploadDir');
      let dstStatus = await this.exists(dstDir);
      if (dstStatus && dstStatus !== 'd') {
        throw utils.formatError(
          `Bad path ${dstDir}`,
          'uploadDir',
          errorCode.badPath
        );
      }
      if (!dstStatus) {
        await this.mkdir(dstDir, true);
      }
      let dirEntries = fs.readdirSync(srcDir, {
        encoding: 'utf8',
        withFileTypes: true
      });
      dirEntries = dirEntries.filter((item) => filter.test(item.name));
      for (let e of dirEntries) {
        if (e.isDirectory()) {
          let newSrc = join(srcDir, e.name);
          let newDst = dstDir + this.remotePathSep + e.name;
          await this.uploadDir(newSrc, newDst);
        } else if (e.isFile()) {
          let src = join(srcDir, e.name);
          let dst = dstDir + this.remotePathSep + e.name;
          await this.fastPut(src, dst);
          this.client.emit('upload', {source: src, destination: dst});
        } else {
          this.debugMsg(
            `uploadDir: File ignored: ${e.name} not a regular file`
          );
        }
      }
      return `${srcDir} uploaded to ${dstDir}`;
    } catch (err) {
      return utils.handleError(err, 'uploadDir');
    }
  }

  async downloadDir(srcDir, dstDir, filter = /.*/) {
    try {
      this.debugMsg(`downloadDir -> ${srcDir} ${dstDir}`);
      utils.haveConnection(this, 'downloadDir');
      let fileList = await this.list(srcDir, filter);
      let dstStatus = await utils.localExists(dstDir);
      if (dstStatus && dstStatus !== 'd') {
        throw utils.formatError(
          `Bad path ${dstDir}`,
          'downloadDir',
          errorCode.badPath
        );
      }
      if (!dstStatus) {
        fs.mkdirSync(dstDir, {recursive: true});
      }
      for (let f of fileList) {
        if (f.type === 'd') {
          let newSrc = srcDir + this.remotePathSep + f.name;
          let newDst = join(dstDir, f.name);
          await this.downloadDir(newSrc, newDst);
        } else if (f.type === '-') {
          let src = srcDir + this.remotePathSep + f.name;
          let dst = join(dstDir, f.name);
          await this.fastGet(src, dst);
          this.client.emit('download', {source: src, destination: dst});
        } else {
          this.debugMsg(
            `downloadDir: File ignored: ${f.name} not regular file`
          );
        }
      }
      return `${srcDir} downloaded to ${dstDir}`;
    } catch (err) {
      return utils.handleError(err, 'downloadDir');
    }
  }

  /**
   * @async
   *
   * End the SFTP connection
   *
   */
  end() {
    return new Promise((resolve, reject) => {
      const endErrorListener = (err) => {
        // we don't care about errors at this point
        // so do nothiing
        this.debugMsg(
          `endErrorListener called with ${err.message} and code ${err.code}`
        );
        this.errorHandled = true;
        if (err.code !== 'ECONNRESET') {
          reject(utils.formatError(err, 'end'));
        } else {
          this.debugMsg('Error is ECONNRESET - ignoring error');
        }
      };

      try {
        if (!utils.hasListener(this.client, 'error', 'endErrorListener')) {
          this.debugMsg('Adding enderrorListener');
          this.client.prependListener('error', endErrorListener);
        } else {
          this.debugMsg('endErrorListener already set');
        }
        this.endCalled = true;
        if (utils.haveConnection(this, 'end', reject)) {
          this.debugMsg('Have connection - calling end()');
          this.client.end();
        } else {
          this.debugMsg('No connection - skipping call to end()');
        }
        resolve(true);
      } catch (err) {
        utils.handleError(err, 'end', reject);
      } finally {
        this.sftp = undefined;
        this.endCalled = false;
      }
    });
  }
}

module.exports = SftpClient;
