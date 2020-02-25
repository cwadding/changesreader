const EventEmitter = require('events').EventEmitter
const async = require('async')
const axios = require('axios').default
const pkg = require('./package.json')

// get Millsecond timestamp
const getTS = () => {
  const d = new Date()
  return d.getTime()
}

/**
 * Monitors the changes feed (after calling .start()/.get()) and emits events
 *  - 'change' - per change
 *  - 'batch' - per batch of changes
 *  - 'seq' - per change of sequence number
 *  - 'error' - per 4xx error (except 429)
 *
 * @param {String} db - Name of the database.
 * @param {String} couchURL - The URL (including credentials of the CouchDB service)
 */
class ChangesReader {
  // constructor
  constructor (db, couchURL, headers) {
    this.db = db
    this.couchURL = couchURL
    this.setDefaults()
    const defaultHeaders = {
      'user-agent': `${pkg.name}/${pkg.version} (Node.js ${process.version})`
    }
    this.headers = Object.assign(defaultHeaders, headers || {})
  }

  // set defaults
  setDefaults () {
    this.ee = new EventEmitter()
    this.batchSize = 100
    this.fastChanges = false
    this.since = 'now'
    this.includeDocs = false
    this.timeout = 60000
    this.heartbeat = 5000
    this.started = false
    this.wait = false
    this.stopOnEmptyChanges = false // whether to stop polling if we get an empty set of changes back
    this.continue = true // whether to poll again
    this.qs = {} // extra querystring parameters
    this.selector = null
  }

  // prevent another poll happening
  stop () {
    this.continue = false
  }

  // called to start listening to the changes feed. The opts object can contain:
  // - batchSize - the number of records to return per HTTP request
  // - since - the the sequence token to start from (defaults to 'now')
  start (opts) {
    const self = this
    let lastReqTS

    // if we're already listening for changes
    if (self.started) {
      // return the existing event emitter
      return self.ee
    }
    self.started = true

    // handle overidden defaults
    opts = opts || {}
    Object.assign(self, opts)

    // monitor the changes feed forever
    async.doWhilst((next) => {
      // formulate changes feed longpoll HTTP request
      const req = {
        baseURL: self.couchURL,
        url: encodeURIComponent(self.db) + '/_changes',
        method: 'post',
        params: {
          feed: 'longpoll',
          timeout: self.timeout,
          since: self.since,
          limit: self.batchSize,
          include_docs: self.includeDocs
        },
        data: {},
        headers: this.headers
      }
      if (self.fastChanges) {
        req.params.seq_interval = self.batchSize
      }
      if (self.selector) {
        req.params.filter = '_selector'
        req.data.selector = self.selector
      }
      Object.assign(req.params, opts.qs)

      // make HTTP request to get up to batchSize changes from the feed
      lastReqTS = getTS()
      axios(req).then((response) => {
        const data = response.data
        const timeSinceLastReq = getTS() - lastReqTS

        // and we have some results
        if (data && data.results && data.results.length > 0) {
          // emit 'change' events
          for (const i in data.results) {
            self.ee.emit('change', data.results[i])
          }
        }

        // update the since state
        if (data && data.last_seq && data.last_seq !== self.since) {
          self.since = data.last_seq
          self.ee.emit('seq', self.since)
        }

        // stop on empty batch or small batch
        if (self.stopOnEmptyChanges && data && typeof data.results !== 'undefined' && data.results.length < self.batchSize) {
          self.continue = false
        }

        // batch event
        // emit 'batch' event
        if (self.wait) {
          if (data && data.results && data.results.length > 0) {
            self.ee.emit('batch', data.results, () => {
              next()
            })
          } else {
            if (timeSinceLastReq > self.timeout) {
              next()
            } else {
              setTimeout(next, self.timeout - timeSinceLastReq)
            }
          }
        } else {
          if (data && data.results && data.results.length > 0) {
            self.ee.emit('batch', data.results)
            next()
          } else {
            if (!self.continue) {
              return next()
            }
            if (timeSinceLastReq > self.timeout) {
              next()
            } else {
              setTimeout(next, self.timeout - timeSinceLastReq)
            }
          }
        }
      }).catch((err) => {
        // error (wrong password, bad since value etc)
        err.statusCode = (err.response && err.response.status) || 500
        self.ee.emit('error', err)

        // if the error is fatal
        if (err && err.statusCode && err.statusCode >= 400 && err.statusCode !== 429 && err.statusCode < 500) {
          self.continue = false
          next(err.reason)
        } else {
          next()
        }
      })
    },

    // function that decides if the doWhilst loop will continue to repeat
    () => {
      return self.continue
    },
    () => {
      // reset
      self.ee.emit('end', self.since)
      self.setDefaults()
    })

    // return the event emitter to the caller
    return self.ee
  }

  // called to start listening to the changes feed for a finite number of changes. The opts object can contain:
  // - batchSize - the number of records to return per HTTP request
  // - since - the sequence token to start from (defaults to 'now')
  get (opts) {
    this.stopOnEmptyChanges = true
    return this.start(opts)
  }

  // called to spool through changes to "now" in one long HTTP request
  spool (opts) {
    const liner = require('./lib/liner.js')
    const changeProcessor = require('./lib/changeprocessor.js')
    const self = this
    self.setDefaults()
    opts = opts || {}
    Object.assign(self, opts)
    const req = {
      method: 'post',
      baseURL: self.couchURL,
      url: encodeURIComponent(self.db) + '/_changes',
      params: {
        since: self.since,
        include_docs: self.includeDocs,
        seq_interval: self.batchSize
      },
      responseType: 'stream',
      data: {},
      headers: this.headers
    }
    if (self.selector) {
      req.params.filter = '_selector'
      req.data.selector = self.selector
    }
    const lin = liner()
    const cp = changeProcessor(self.ee, self.batchSize)
    axios(req).then((response) => {
      response.data
        .pipe(lin)
        .pipe(cp)
        .on('finish', (lastSeq) => {
          // the 'end' event was triggering before the last data event
          setTimeout(() => {
            self.ee.emit('end', cp.lastSeq)
          }, 10)
        })
        .on('error', (e) => {
          self.ee.emit('error', e)
        })
    })

    return self.ee
  }
}

module.exports = ChangesReader
