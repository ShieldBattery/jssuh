'use strict';

const { BufferList, BufferListStream } = require('bl')
const iconv = require('iconv-lite')
const decodeImplode = require('implode-decoder')

const { Transform, Writable } = require('stream')
const zlib = require('zlib')

// The replay file contains 6 separate blocks, which are in the following format:
// { u32 checksum, u32 chunk_count, { u32 size, u8 data[size] } chunks[chunk_count] }
// The data is split into 0x2000 byte chunks if it is large enough.
// If chunk size is less than the excepted, the chunk has been compressed with implode.
//
// SCR data is { u32 section_tag, u32 size, {block} }

const BLOCK_DECODE_HEADER = 0
const BLOCK_DECODE_CHUNK = 1
const BLOCK_DECODE_DATA = 2
const BLOCK_DECODE_RAW = 3
const BLOCK_DECODE_SKIP = 4
const BLOCK_WAIT = 5
const MAX_CHUNK_SIZE = 0x2000
const MODE_BLOCK = 0
const MODE_RAW = 1
const MODE_SCR = 2

// SCR replays contain inflate streams.
// However, the older replay format for some years after SCR release,
// and the only way to know their compression type is to see if the
// compressed stream starts with 0x78, 0x9c or not
// This class will also have a member `hadInflate` that gets set if
// any inflate streams were met so the parent can see if the replay
// is usable on 1.16.1 or not
class Decompressor {
  constructor() {
    this.hadInflate = false
  }

  newDecompressStream() {
    return new DecompressStream(this)
  }
}

class DecompressStream extends Transform {
  constructor(parent) {
    super()
    this._parent = parent
    this._stream = null
    // Buffering just in case for the stupid stream which writes one byte at a time.
    this._buffer = null
  }

  _transform(block, enc, done) {
    if (this._stream === null) {
      if (this._buffer !== null || block.length < 2) {
        if (this._buffer === null) {
          this._buffer = new BufferList()
        }
        this._buffer.append(block)
        if (this._buffer.length < 2) {
          return done();
        }
      }
      if (this._buffer !== null) {
        block = this._buffer.slice()
      }
      if (block.readUInt16LE(0) === 0x9c78) {
        this._stream = zlib.createInflate()
        this._parent.hadInflate = true
      } else {
        this._stream = decodeImplode()
      }
      this._stream.on('data', d => this.emit('data', d))
      this._stream.on('close', () => this.emit('close'))
      this._stream.on('end', () => this.emit('end'))
      this._stream.on('error', e => this.emit('error', e))
    }
    return this._stream.write(block, enc, done)
  }

  _flush(done) {
    if (this._stream === null) {
      done()
    } else {
      this._stream.end(done)
    }
  }
}

class BlockDecoder extends Writable {
  constructor() {
    super()
    this._buf = new BufferList()
    this._output = null
    this._blockHandlers = []
    this._scrBlockHandlers = new Map()
    this._state = BLOCK_DECODE_HEADER
    this._blockPos = 0
    this._pos = 0
    this._skip = 0
    this._chunkRemaining = 0
    this._error = false
    this._rawScrBlock = false
    this._decompressor = new Decompressor()
  }

  // The promise resolves once the entire block has been parsed
  nextBlockHandler(size, handler) {
    return new Promise((res, rej) => {
      this._blockHandlers.push({ size, handler, resolve: res, reject: rej, mode: MODE_BLOCK })
      if (this._state === BLOCK_DECODE_HEADER && this._blockHandlers.length === 1) {
        // We didn't have any handler for this block before, so run `process()`
        this._process()
      }
    })
  }

  // Reads just `size` bytes from stream without any format.
  // Returned promise resolves once all bytes have been read.
  rawBlockHandler(size, handler) {
    return new Promise((res, rej) => {
      this._blockHandlers.push({ size, handler, resolve: res, reject: rej, mode: MODE_RAW })
      if (this._state === BLOCK_DECODE_HEADER && this._blockHandlers.length === 1) {
        // We didn't have any handler for this block before, so run `process()`
        this._process()
      }
    })
  }

  handleScrBlocks(offset) {
    this._scrOffset = offset
    return new Promise((res, rej) => {
      this._blockHandlers.push({ resolve: res, reject: rej, mode: MODE_SCR })
      if (this._state === BLOCK_DECODE_HEADER && this._blockHandlers.length === 1) {
        // We didn't have any handler for this block before, so run `process()`
        this._process()
      }
    })
  }

  // If `rawData` is true, just forward the extension block without decompressing it; `size`
  // will be unused.
  // If `rawData` is false, assume the extension block is similar list of deflated blocks
  // that the main replay file is, in which case the user must know size beforehand to
  // decompress the data properly.
  scrBlockHandler(tag, size, handler, rawData) {
    const buffer = Buffer.from(tag)
    if (buffer.length !== 4) {
      throw new Error('SCR block tags must be 4 bytes')
    }
    const tagUint = buffer.readUInt32LE(0)
    const old = this._scrBlockHandlers.get(tagUint)
    if (old) {
      if (old.size !== size) {
        throw new Error(`Conflicting SCR block size for ${tag}: requested ${size}, was ${old.size}`)
      }
      old.handlers.push(handler)
    } else {
      this._scrBlockHandlers.set(tagUint, { handlers: [handler], size, rawData })
    }
  }

  hadInflatedData() {
    return this._decompressor.hadInflate;
  }

  _write(block, enc, done) {
    if (!this._error) {
      this._buf.append(block)
      this._process()
    }
    done()
  }

  _requireBufLength(len) {
    if (this._buf.length < len) {
      if (this._end) {
        this._blockHandlers[0].reject(new Error('Unexpected end of file'))
      }
      return false
    }
    return true
  }

  _consume(size) {
    this._buf.consume(size)
    this._pos += size
  }

  _process() {
    while (!this._error && this._buf.length > 0) {
      switch (this._state) {
        case BLOCK_DECODE_HEADER: {
          if (this._blockHandlers.length === 0) {
            return
          }
          if (this._blockHandlers[0].mode === MODE_RAW) {
            this._state = BLOCK_DECODE_RAW
            break
          }
          if (this._blockHandlers[0].mode === MODE_SCR) {
            if (this._pos < this._scrOffset) {
              this._skip = this._scrOffset - this._pos
              this._state = BLOCK_DECODE_SKIP
              break
            }
            // SCR blocks tell their block size inline
            if (!this._requireBufLength(0x14)) {
              return
            }
            const tag = this._buf.readUInt32LE(0)
            const size = this._buf.readUInt32LE(4)
            this._consume(8)
            const handle = this._scrBlockHandlers.get(tag)
            if (handle) {
              this._blockHandlers[0].size = handle.size
              this._blockHandlers[0].handler = new BufferListStream((err, buf) => {
                if (err) {
                  this.emit('error', err)
                } else {
                  for (const handler of handle.handlers) {
                    handler(buf)
                  }
                }
              })
              if (handle.rawData) {
                this._blockHandlers[0].size = size
                this._state = BLOCK_DECODE_RAW
                this._rawScrBlock = true
                break
              }
            } else {
              this._skip = size
              this._state = BLOCK_DECODE_SKIP
              break
            }
          }
          const blockSize = this._blockHandlers[0].size
          // Empty blocks don't even have their header information, so just signal end of block
          // and start decoding the next one.
          if (blockSize === 0) {
            this._blockHandlers[0].handler.end()
            this._blockHandlers[0].resolve()
            this._blockHandlers.shift()
            break
          }
          if (!this._requireBufLength(0xc)) {
            return
          }
          this._blockPos = 0
          // TODO: Could check the checksum
          const chunks = this._buf.readUInt32LE(4)
          this._consume(8)
          const exceptedChunks = Math.ceil(blockSize / MAX_CHUNK_SIZE)
          if (chunks !== exceptedChunks) {
            const error = new Error(`Excepted ${exceptedChunks} chunks, got ${chunks}`)
            this._blockHandlers[0].reject(error)
            this._error = true
            return
          }
          this._state = BLOCK_DECODE_CHUNK
        } break
        case BLOCK_DECODE_CHUNK: {
          if (!this._requireBufLength(0x4)) {
            return
          }
          const remaining = this._blockHandlers[0].size - this._blockPos
          const outSize = Math.min(remaining, MAX_CHUNK_SIZE)
          const inSize = this._buf.readUInt32LE(0)
          this._consume(4)
          this._chunkRemaining = inSize
          if (outSize === inSize) {
            this._output = this._blockHandlers[0].handler
          } else {
            this._output = this._decompressor.newDecompressStream()
            const rej = this._blockHandlers[0].reject
            this._output.on('error', e => rej(e))
            const isLastChunk = remaining <= MAX_CHUNK_SIZE
            this._output.pipe(this._blockHandlers[0].handler, { end: isLastChunk })
          }
          this._state = BLOCK_DECODE_DATA
        } break
        case BLOCK_DECODE_RAW: {
          this._output = this._blockHandlers[0].handler
          this._state = BLOCK_DECODE_DATA
          this._chunkRemaining = this._blockHandlers[0].size
        } break
        case BLOCK_DECODE_DATA: {
          if (!this._requireBufLength(0x1)) {
            return
          }
          const size = Math.min(this._chunkRemaining, this._buf.length)
          this._chunkRemaining -= size
          this._output.write(this._buf.slice(0, size))
          this._consume(size)
          if (this._chunkRemaining === 0) {
            let end = false
            switch (this._blockHandlers[0].mode) {
              case MODE_BLOCK: case MODE_SCR: {
                this._blockPos += MAX_CHUNK_SIZE
                if (this._blockPos >= this._blockHandlers[0].size || this._rawScrBlock) {
                  this._rawScrBlock = false
                  end = true
                } else {
                  this._state = BLOCK_DECODE_CHUNK
                }
              } break
              case MODE_RAW: {
                end = true
              } break
            }
            const isDecompressOutput = this._output !== this._blockHandlers[0].handler
            if (end) {
              this._state = BLOCK_DECODE_HEADER
              if (this._blockHandlers[0].mode === MODE_SCR) {
                // SCR data will last until end of file,
                // no shifting in new handlers.
                this._state = BLOCK_WAIT
                this._output.end(() => {
                  this._state = BLOCK_DECODE_HEADER
                  this._process()
                })
                this._output = null
                return
              } else {
                const res = this._blockHandlers[0].resolve
                this._output.end(res)
                this._output = null
                this._blockHandlers.shift()
              }
            } else if (isDecompressOutput) {
              this._state = BLOCK_WAIT
              this._output.end(() => {
                this._output.unpipe()
                this._state = BLOCK_DECODE_CHUNK
                this._process()
              })
            }
          }
        } break
        case BLOCK_DECODE_SKIP: {
          if (!this._requireBufLength(1)) {
            return
          }
          const size = Math.min(this._skip, this._buf.length)
          this._skip -= size
          this._consume(size)
          if (this._skip === 0) {
            this._state = BLOCK_DECODE_HEADER
          }
        } break
        case BLOCK_WAIT: {
          // Nothing, handled by end callback of whoever waits
          return
        }
      }
    }
    // SCR data lasts until end of file, so check eof here explicitly
    if (this._end && this._buf.length === 0 && this._blockHandlers.length > 0) {
      if (this._blockHandlers[0].mode === MODE_SCR) {
        this._blockHandlers[0].resolve()
        this._blockHandlers = []
        return
      }
    }
  }

  noMoreData() {
    this._end = true
    this._process()
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
  const extSelectLength = data => {
    if (data.length < 1) {
        return null;
    }
    return 2 + data.readUInt8(0) * 4
  }
  return {
    KEEP_ALIVE: c(0x5, 1),
    SAVE: fun(0x6, saveLength),
    LOAD: fun(0x7, saveLength),
    RESTART: c(0x8, 1),
    SELECT: fun(0x9, selectLength),
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
    SET_TURN_RATE: c(0x5f, 0x2),
    RIGHT_CLICK_EXT: c(0x60, 0xc),
    TARGETED_ORDER_EXT: c(0x61, 0xd),
    UNLOAD_EXT: c(0x62, 5),
    SELECT_EXT: fun(0x63, extSelectLength),
    SELECTION_ADD_EXT: fun(0x64, extSelectLength),
    SELECTION_REMOVE_EXT: fun(0x65, extSelectLength),
    NEW_NETWORK_SPEED: c(0x66, 4),
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
const REPLAY_MAGIC_SCR = 0x53526573

class ReplayParser extends Transform {
  constructor(options) {
    const opts = Object.assign({
      encoding: 'auto',
    }, options)
    super({ objectMode: true })

    this._cmdBuf = new BufferList()
    this._decoder = new BlockDecoder()
    this._chkPipe = null
    this._finished = false
    this._isScr = false

    const bufferListStreamPromise = (res, rej) => (
      new BufferListStream((err, buf) => {
        if (err) {
          rej(err)
        } else {
          res(buf)
        }
      })
    )
    const decodeToBuffer = size => (
      new Promise((res, rej) => {
        this._decoder.nextBlockHandler(size, bufferListStreamPromise(res, rej)).catch(rej)
      })
    )
    const streamBlockTo = (size, func) => (
      new Promise((res, rej) => {
        const stream = new Writable()
        stream._write = (data, enc, done) => {
          try {
            func(data)
          } catch (e) {
            rej(e)
          }
          done()
        }
        this._decoder.nextBlockHandler(size, stream).then(res, rej)
      })
    )

    const magic = decodeToBuffer(0x4)
      .then(async buf => {
        const magic = buf.readUInt32LE(0)
        if (magic !== REPLAY_MAGIC && magic !== REPLAY_MAGIC_SCR) {
          throw new Error('Not a replay file')
        }
        this._isScr = magic === REPLAY_MAGIC_SCR
        if (this._isScr) {
          const offset = await new Promise((res, rej) => {
            this._decoder.rawBlockHandler(4, bufferListStreamPromise(res, rej)).catch(rej)
          })
          this._scrOffset = offset.readUInt32LE(0)
        }
      }, () => {
        throw new Error('Not a replay file')
      })
    const header = magic.then(() => decodeToBuffer(0x279))
      .then(buf => {
        const isScr = this._isScr || this._decoder.hadInflatedData()
        this._setupPlayerMappings(buf)
        this._emitHeader(buf, opts.encoding, isScr)
      })
    const cmdsSize = magic.then(() => decodeToBuffer(0x4))
      .then(buf => buf.readUInt32LE(0))

    // Wait for header to be emitted before emitting any commands
    const both = Promise.all([header, cmdsSize]).then(([, b]) => b)
    const cmds = both.then(cmdsSize => streamBlockTo(cmdsSize, data => this._onCommandData(data)))
    const chkSize = both.then(() => decodeToBuffer(0x4))
      .then(buf => buf.readUInt32LE(0))

    const chk = chkSize.then(chkSize => {
      if (this._chkPipe) {
        return this._decoder.nextBlockHandler(chkSize, this._chkPipe)
      } else {
        // Discard
        return streamBlockTo(chkSize, () => {})
      }
    })

    Promise.all([cmds, chk])
      .catch(e => this.emit('error', e))
      .then(async () => {
        if (this._isScr) {
          await this._decoder.handleScrBlocks(this._scrOffset)
        }
        this._finished = true
        this.end()
        if (this._onEnd) {
          this._onEnd()
        }
      })
  }

  scrSection(tag, size, cb, rawData = false) {
    this._decoder.scrBlockHandler(tag, size, cb, false)
  }

  rawScrSection(tag, cb) {
    this._decoder.scrBlockHandler(tag, 0, cb, true)
  }

  pipeChk(stream) {
    this._chkPipe = stream
  }

  _setupPlayerMappings(buf) {
    this._stormPlayerToGamePlayer = []
    for (let i = 0; i < 8; i++) {
      const offset = 0xa1 + 0x24 * i
      const stormId = buf.readInt32LE(offset + 0x4)
      if (stormId >= 0) {
        this._stormPlayerToGamePlayer[stormId] = buf.readUInt32LE(offset)
      }
    }
  }

  _emitHeader(buf, encoding, remastered) {
    const cstring = buf => {
      let text = buf
      const end = buf.indexOf(0)
      if (end !== -1) {
        text = buf.slice(0, end)
      }
      if (encoding === 'auto') {
        const string = iconv.decode(text, 'cp949')
        if (string.indexOf('\ufffd') !== -1) {
          return iconv.decode(text, 'cp1252')
        } else {
          return string
        }
      } else {
        return iconv.decode(buf, encoding)
      }
    }
    const gameName = cstring(buf.slice(0x18, 0x18 + 0x18))
    const mapName = cstring(buf.slice(0x61, 0x61 + 0x20))
    const gameType = buf.readUInt16LE(0x81)
    const gameSubtype = buf.readUInt16LE(0x83)
    const durationFrames = buf.readUInt32LE(0x1)
    const seed = buf.readUInt32LE(0x8)

    const raceStr = race => {
      switch (race) {
        case 0: return 'zerg'
        case 1: return 'terran'
        case 2: return 'protoss'
        default: return 'unknown'
      }
    }
    const players = []
    // There are actually 12 players, but one can just assume 8-10 be unused and 11 to be neutral
    for (let i = 0; i < 8; i++) {
      const offset = 0xa1 + 0x24 * i
      const type = buf.readUInt8(offset + 0x8)
      // TODO: Not sure if UMS maps can have other types that should be reported here
      if (type === 1 || type === 2) {
        players.push({
          id: buf.readUInt32LE(offset),
          isComputer: type === 1,
          race: raceStr(buf.readUInt8(offset + 0x9)),
          name: cstring(buf.slice(offset + 0xb, offset + 0xb + 0x19)),
          team: buf.readUInt8(offset + 0xa),
        })
      }
    }
    const header = {
      gameName,
      mapName,
      gameType,
      gameSubtype,
      players,
      durationFrames,
      seed,
      remastered,
    }
    this.emit('replayHeader', header)
  }

  _transform(block, enc, done) {
    this._decoder.write(block)
    done()
  }

  _flush(done) {
    if (this._finished) {
      done()
    } else {
      this._decoder.noMoreData()
      this._onEnd = done
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
        const player = this._stormPlayerToGamePlayer[this._cmdBuf.readUInt8(pos)]
        pos += 1
        const id = this._cmdBuf.readUInt8(pos)
        const len = commandLength(id, this._cmdBuf.slice(pos + 1))
        if (len === null || pos + len > frameEnd) {
          throw new Error(`Invalid command 0x${id.toString(16)} on frame ${frame}`)
        }
        const data = this._cmdBuf.slice(pos + 1, pos + len)
        pos += len

        this.push({
          frame,
          id,
          player,
          data,
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
