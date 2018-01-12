const thrift = require('thrift')
const genericPool = require('generic-pool')
const hbase = require('hbase-rpc-client')

const CLOSE_MESSAGE = 'HBASE client connection closed'
const TIMEOUT_MESSAGE = 'Hbase client timeout'

function makePut(options) {
  const put = new hbase.Put(options.rowkey)

  Object.keys(options.columns).forEach(key => {
    const parts = key.split(':')
    const family = parts[1] ? parts[0] : 'd'
    const qualifier = parts[1] ? parts[1] : parts[0]
    
    let value = options.columns[key]
    
    // stringify JSON and arrays and convert numbers to string
    if (typeof value !== 'string') {
      value = JSON.stringify(value)
    }
    
    if (value) {
      put.add(family, qualifier, value)
    }
  })
  
  return put
}


function addFilters(scan, filters) {
  
  if (!filters.length) {
    return  
  }
  
  const list = new hbase.FilterList()

  filters.forEach(filter => {
    const comp = filter.comparator === '=' ?
      "EQUAL" : filter.comparator
    
    list.addFilter({
      singleColumnValueFilter: {
        columnFamily: filter.family,
        columnQualifier: filter.qualifier,
        compareOp: comp,
        comparator: {
          substringComparator: {
            substr: filter.value
          }
        },
        filterIfMissing: filter.latest === false ? false : true,
        latestVersionOnly: filter.latest === false ? false : true
      }
    })       
  }) 
  
  scan.setFilter(list)
}

function HbaseClient(options) {
  this._open = true
  this.client = hbase({
    zookeeperHosts: options.hosts,
    zookeeperRoot: options.root,
    zookeeperReconnectTimeout: options.timeout || 30000,
    rpcTimeout: options.timeout || 30000,
    callTimeout: options.timeout || 30000,
    tcpNoDelay: true,
    tcpKeepAlive: true
  })
}

HbaseClient.prototype.getRow = function(options) {
  const self = this
  const get = new hbase.Get(options.rowkey)

  return new Promise((resolve, reject) => {
    self.client.get(options.table, get, function(err, resp) {       
      const row = {}

      if (err) {
        return reject(err)
      }

      if (!resp) {
        return resolve(undefined)
      }

      resolve({
        row: resp.row,
        columns: resp.cols
      })
    })      
  })
}

HbaseClient.prototype.getRows = function(options) {
  const self = this
  const gets = options.rowkeys.map(rowkey => {
    return new hbase.Get(rowkey)
  })

  return new Promise((resolve, reject) => {
    self.client.mget(options.table, gets, function(err, resp) {       
      const rows = []

      if (err) {
        return reject(err)
      }

      resp.forEach(row => {
        if (row.row) {
          rows.push({
            row: row.row,
            columns: row.cols
          })
        }
      })

      resolve(rows)
    })      
  })
}  

HbaseClient.prototype.putRow = function(options) {
  const self = this
  const put = makePut({
    rowkey: options.rowkey, 
    columns: options.columns
  })

  const rows = {}
  rows[options.rowkey] = options.columns

  return self._removeEmptyColumns({
    table: options.table, 
    rows: rows
  }, options.removeEmpty)
  .then(() => {
    return new Promise((resolve, reject) => {
      self.client.put(options.table, put, function(err, resp) {               
        if (err) {
          return reject(err)
        }

        resolve()
      })      
    })
  })
}  

HbaseClient.prototype.putRows = function(options) {
  const self = this
  const rows = []
  Object.keys(options.rows).forEach(key => {

    rows.push(makePut({
      rowkey: key,
      columns: options.rows[key]
    }))
  })

  if (!rows.length) {
    return Promise.resolve()
  }

  return self._removeEmptyColumns({
    table: options.table, 
    rows: options.rows
  }, options.removeEmpty)
  .then(() => {
    return new Promise((resolve, reject) => {
      self.client.mput(options.table, rows, function(err, resp) {               
        if (err) {
          return reject(err)
        }

        resolve()
      })      
    })      
  })
}  

HbaseClient.prototype.getScan = function(options) {
  const self = this
  return new Promise((resolve, reject) => {
    const scan = self.client.getScanner(options.table, 
                                        options.startRow, 
                                        options.stopRow)
    if (options.reversed) {
      scan.setReversed()

    }

    if (options.filters) {
      addFilters(scan, options.filters)
    }

    const rows = []
    getNext()

    function getNext(getMarker) {
      scan.next((err, row) => {           
        if (err) {
          return reject(err)
        }

        if (!row.row || getMarker) {
          scan.close()
          resolve({
            rows: rows,
            marker: row.row ? row.row.toString('utf8') : undefined
          })
          return
        }        

        rows.push({
          row: row.row,
          columns: row.cols
        })


        if (rows.length === options.limit
           && options.excludeMarker) {
          scan.close()
          resolve({
            rows: rows
          })  

        } else if (rows.length === options.limit) {
          getNext(true)  

        } else {
          getNext()
        }
      })
    }
  })
}

HbaseClient.prototype.delete = function(options) {
  const self = this
  const del = new hbase.Delete(options.rowkey)

  if (options.columns) {
    options.columns.forEach(c => {
      const parts = c.split(':')
      const family = parts[1] ? parts[0] : 'd'
      const qualifier = parts[1] ? parts[1] : parts[0]      
      del.deleteColumns(family, qualifier)
    })
  }

  return new Promise((resolve, reject) => {
    self.client.delete(options.table, del, function(err, resp) {               
      if (err) {
        return reject(err)
      }

      resolve()
    })      
  })
}

HbaseClient.prototype._removeEmptyColumns = function(options, remove) {  
  const self = this
  let key

  if (!remove) {
    return Promise.resolve()
  }

  const list = [] 

  Object.keys(options.rows).forEach(key => {
    list.push(removeEmptyColumns(key, options.rows[key]))
  })

  return Promise.all(list)


  function removeEmptyColumns(rowkey, columns) {
    const removed = []

    for (key in columns) {
      if (!columns[key] && columns[key] !== 0) {
        removed.push(key)
      }
    }

    if (!removed.length) {
      return Promise.resolve()  
    }

    return self.delete({
      table: options.table,
      rowkey: rowkey,
      columns: removed
    })   
  }
}  


/**
 * HbaseClient
 * HBase client class
 */

function HbaseClientPool(options) {

  /**
   * create
   */

  function create(cb) {
    return new HbaseClient(options, cb)
  }

  const factory = {
    create: create,
    destroy: () => {}
  }
  
  const params = {
    testOnBorrow: false,
    max: options.max_sockets || 100,
    min: options.min_sockets || 5,
    acquireTimeoutMillis: options.timeout || 30000,
    idleTimeoutMillis: options.timeout || 30000
  }

  const pool = genericPool.createPool(factory, params)
  
  pool.getClient = function() {  
    return this.acquire() 
  }
  
  return pool
}

module.exports = HbaseClientPool
