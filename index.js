'use strict';

const BufferList = require('bl')
const iconv = require('iconv-lite')
const decodeImplode = require('implode-decoder')

const { Transform, Writable } = require('stream')

// The replay file contains 6 separate blocks, which are in the following format:
// { u32 checksum, u32 chunk_count, { u32 size, u8 data[size] } chunks[chunk_count] }
// The data is split into 0x2000 byte chunks if it is large enough.
// If chunk size is less than the excepted, the chunk has been compressed with implode.

const BLOCK_DECODE_HEADER = 0
const BLOCK_DECODE_CHUNK = 1
const BLOCK_DECODE_DATA = 2
const MAX_CHUNK_SIZE = 0x2000

class BlockDecoder extends Writable {
  constructor() {
    super()
    this._buf = new BufferList()
    this._output = null
    this._blockHandlers = []
    this._state = BLOCK_DECODE_HEADER
    this._blockPos = 0
    this._chunkRemaining = 0
    this._error = false
  }

  nextBlockHandler(size, handler) {
    this._blockHandlers.push({ size, handler })
    if (this._state === BLOCK_DECODE_HEADER && this._blockHandlers.length === 1) {
      // We didn't have any handler for this block before, so run `process()`
      this._process()
    }
  }

  _write(block, enc, done) {
    if (!this._error) {
      this._buf.append(block)
      this._process()
    }
    done()
  }

  _process() {
    while (!this._error && this._buf.length > 0) {
      switch (this._state) {
        case BLOCK_DECODE_HEADER: {
          if (this._buf.length < 0xc || this._blockHandlers.length === 0) {
            return
          }
          this._blockPos = 0
          // TODO: Could check the checksum
          const blockSize = this._blockHandlers[0].size
          const chunks = this._buf.readUInt32LE(4)
          this._buf.consume(8)
          const exceptedChunks = Math.ceil(blockSize / MAX_CHUNK_SIZE)
          if (chunks !== exceptedChunks) {
            this.emit('error', new Error(`Excepted ${exceptedChunks} chunks, got ${chunks}`))
            this._error = true
            return
          }
          this._state = BLOCK_DECODE_CHUNK
        } break
        case BLOCK_DECODE_CHUNK: {
          if (this._buf.length < 0x4) {
            return
          }
          const remaining = this._blockHandlers[0].size - this._blockPos
          const outSize = Math.min(remaining, MAX_CHUNK_SIZE)
          const inSize = this._buf.readUInt32LE(0)
          this._buf.consume(4)
          this._chunkRemaining = inSize
          if (this._output) {
            // Remove the possible event listeners that have been added
            // if the previous chunk was decodeImplode-piped to _output
            this._output.unpipe()
          }
          if (outSize === inSize) {
            this._output = this._blockHandlers[0].handler
          } else {
            this._output = decodeImplode()
            this._output.pipe(this._blockHandlers[0].handler)
          }
          this._state = BLOCK_DECODE_DATA
        } break
        case BLOCK_DECODE_DATA: {
          const size = Math.min(this._chunkRemaining, this._buf.length)
          this._chunkRemaining -= size
          this._output.write(this._buf.slice(0, size))
          this._buf.consume(size)
          if (this._chunkRemaining === 0) {
            this._blockPos += MAX_CHUNK_SIZE
            if (this._blockPos >= this._blockHandlers[0].size) {
              this._state = BLOCK_DECODE_HEADER
              this._output.end()
              this._output = null
              this._blockHandlers.shift()
            } else {
              this._state = BLOCK_DECODE_CHUNK
            }
          }
        } break
      }
    }
  }
}

const CMDS = (() => {
  const c = (id, len) => ({ id, length: () => len })
  const fun = (id, func) => ({ id, length: func })
  const saveLength = data => {
    if (data.length < 5) {
      return null
    }
    const pos = data.indexOf(0, 5)
    return 1 + (pos === -1 ? data.length : pos)
  }
  const selectLength = data => {
    if (data.length < 1) {
        return null;
    }
    return 2 + data.readUInt8(0) * 2
  }
  return {
    KEEP_ALIVE: c(0x5, 1),
    SAVE: fun(0x6, saveLength),
    LOAD: fun(0x7, saveLength),
    RESTART: c(0x8, 1),
    SELECT: c(0x9, selectLength),
    SELECTION_ADD: fun(0xa, selectLength),
    SELECTION_REMOVE: fun(0xb, selectLength),
    BUILD: c(0xc, 8),
    VISION: c(0xd, 3),
    ALLIANCE: c(0xe, 5),
    GAME_SPEED: c(0xf, 2),
    PAUSE: c(0x10, 1),
    RESUME: c(0x11, 1),
    CHEAT: c(0x12, 5),
    HOTKEY: c(0x13, 3),
    RIGHT_CLICK: c(0x14, 10),
    TARGETED_ORDER: c(0x15, 11),
    CANCEL_BUILD: c(0x18, 1),
    CANCEL_MORPH: c(0x19, 1),
    STOP: c(0x1a, 2),
    CARRIER_STOP: c(0x1b, 1),
    REAVER_STOP: c(0x1c, 1),
    ORDER_NOTHING: c(0x1d, 1),
    RETURN_CARGO: c(0x1e, 2),
    TRAIN: c(0x1f, 3),
    CANCEL_TRAIN: c(0x20, 3),
    CLOAK: c(0x21, 2),
    DECLOAK: c(0x22, 2),
    UNIT_MORPH: c(0x23, 3),
    UNSIEGE: c(0x25, 2),
    SIEGE: c(0x26, 2),
    TRAIN_FIGHTER: c(0x27, 1),
    UNLOAD_ALL: c(0x28, 2),
    UNLOAD: c(0x29, 3),
    MERGE_ARCHON: c(0x2a, 1),
    HOLD_POSITION: c(0x2b, 2),
    BURROW: c(0x2c, 2),
    UNBURROW: c(0x2d, 2),
    CANCEL_NUKE: c(0x2e, 1),
    LIFTOFF: c(0x2f, 5),
    TECH: c(0x30, 2),
    CANCEL_TECH: c(0x31, 1),
    UPGRADE: c(0x32, 2),
    CANCEL_UPGRADE: c(0x33, 1),
    CANCEL_ADDON: c(0x34, 1),
    BUILDING_MORPH: c(0x35, 3),
    STIM: c(0x36, 1),
    SYNC: c(0x37, 7),
    VOICE_ENABLE1: c(0x38, 1),
    VOICE_ENABLE2: c(0x39, 1),
    VOICE_SQUELCH1: c(0x3a, 2),
    VOICE_SQUELCH2: c(0x3b, 2),
    START_GAME: c(0x3c, 1),
    DOWNLOAD_PERCENTAGE: c(0x3d, 2),
    CHANGE_GAME_SLOT: c(0x3e, 6),
    NEW_NET_PLAYER: c(0x3f, 8),
    JOINED_GAME: c(0x40, 18),
    CHANGE_RACE: c(0x41, 3),
    TEAM_GAME_TEAM: c(0x42, 2),
    UMS_TEAM: c(0x43, 2),
    MELEE_TEAM: c(0x44, 3),
    SWAP_PLAYERS: c(0x45, 3),
    SAVED_DATA: c(0x48, 13),
    BRIEFING_START: c(0x54, 1),
    LATENCY: c(0x55, 2),
    REPLAY_SPEED: c(0x56, 10),
    LEAVE_GAME: c(0x57, 2),
    MINIMAP_PING: c(0x58, 5),
    MERGE_DARK_ARCHON: c(0x5a, 1),
    MAKE_GAME_PUBLIC: c(0x5b, 1),
    CHAT: c(0x5c, 82),
  }
})()

for (const key of Object.keys(CMDS)) {
  CMDS[key].name = key
  CMDS[CMDS[key].id] = CMDS[key]
}

function commandLength(id, data) {
  const cmd = CMDS[id]
  if (!cmd) {
    return null
  }
  return cmd.length(data)
}

const REPLAY_MAGIC = 0x53526572

const funcAsWritable = fun => {
  const stream = new Writable()
  stream._write = (data, enc, done) => {
    fun(data)
    done()
  }
  return stream
}

class ReplayParser extends Transform {
  constructor(options) {
    const opts = Object.assign({
      encoding: 'auto',
    }, options)
    super({ objectMode: true })

    this._error = false
    this._cmdBuf = new BufferList()
    this._decoder = new BlockDecoder()
    this._decoder.on('error', err => this.emit('error', err))

    this._nextBlockHandler(0x4, new BufferList((err, buf) => {
      if (err) {
        this._emitError(err)
        return
      }
      if (buf.readUInt32LE(0) !== REPLAY_MAGIC) {
        this._emitError(new Error('Not a replay file'))
      }
    }))
    this._nextBlockHandler(0x279, new BufferList((err, buf) => {
      if (err) {
        this.emit('error', err)
        return
      }
      const cstring = buf => {
        let text = buf
        const end = buf.indexOf(0)
        if (end !== -1) {
          text = buf.slice(0, end)
        }
        if (opts.encoding === 'auto') {
          const string = iconv.decode(text, 'cp949')
          if (string.indexOf('\ufffd') !== -1) {
            return iconv.decode(text, 'cp1252')
          } else {
            return string
          }
        } else {
          return iconv.decode(buf, opts.encoding)
        }
      }
      const gameName = cstring(buf.slice(0x18, 0x18 + 0x18))
      const mapName = cstring(buf.slice(0x61, 0x61 + 0x20))
      // TODO: Players etc
      const header = {
        gameName,
        mapName,
      }
      this.emit('replayHeader', header)
    }))
    this._nextBlockHandler(0x4, new BufferList((err, buf) => {
      if (err) {
        this._emitError(err)
        return
      }
      const cmdsSize = buf.readUInt32LE(0)
      this._nextBlockHandler(cmdsSize, funcAsWritable(data => this._onCommandData(data)))
      this._nextBlockHandler(0x4, new BufferList((err, buf) => {
        if (err) {
          this._emitError(err)
          return
        }
        const chkSize = buf.readUInt32LE(0)
        // We don't really care about the chk
        this._nextBlockHandler(chkSize, funcAsWritable(() => { }))
      }))
    }))
  }

  _nextBlockHandler(size, stream) {
    // Filter to block additional data from BlockDecoder after an error occurs
    const errorFilter = new Transform()
    errorFilter._transform = (data, enc, done) => {
      if (!this._error) {
        stream.write(data)
      }
      done()
    }
    errorFilter.on('finish', () => {
      if (!this._error) {
        stream.end()
      }
    })
    errorFilter.on('error', err => {
      this._emitError(err)
    })
    this._decoder.nextBlockHandler(size, errorFilter)
  }

  _transform(block, enc, done) {
    if (!this._error) {
      this._decoder.write(block)
    }
    done()
  }

  _emitError(err) {
    if (!this._error) {
      this.emit('error', err)
      this._error = true
    }
  }

  _onCommandData(data) {
    this._cmdBuf.append(data)
    while (true) {
      if (this._cmdBuf.length < 5) {
        return
      }
      const frameLength = this._cmdBuf.readUInt8(4)
      const frameEnd = 5 + frameLength
      if (this._cmdBuf.length < frameEnd) {
        return
      }
      const frame = this._cmdBuf.readUInt32LE(0)
      let pos = 5
      while (pos < frameEnd) {
        const player = this._cmdBuf.readUInt8(pos)
        pos += 1
        const id = this._cmdBuf.readUInt8(pos)
        const len = commandLength(id, this._cmdBuf.slice(pos + 1))
        if (len === null || pos + len > frameEnd) {
          this._emitError(new Error(`Invalid command 0x${id.toString(16)} on frame ${frame}`))
          return
        }
        pos += len

        this.push({
          frame,
          id,
          player,
          data: this._cmdBuf.slice(pos + 1, pos + len),
        })
      }
      this._cmdBuf.consume(frameEnd)
    }
  }

  static commands() {
    return CMDS
  }
}

module.exports = ReplayParser
