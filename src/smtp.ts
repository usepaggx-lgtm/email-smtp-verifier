import * as net from 'net'

const HELO_DOMAIN = 'mail.emailvalidator.dev'
const FROM_EMAIL = 'noreply@emailvalidator.dev'
const SMTP_PORT = 25
const TIMEOUT = 10000

interface SMTPResult {
  deliverable: boolean
  greylisted: boolean
  reason: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export async function verifySMTP(
  mxHost: string,
  toEmail: string,
  domain: string,
  retries: number
): Promise<SMTPResult> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await trySMTP(mxHost, toEmail)
      if (result.greylisted && attempt < retries) {
        await sleep(3000)
        continue
      }
      return result
    } catch (err: any) {
      if (attempt < retries) {
        await sleep(2000)
        continue
      }
      return { deliverable: false, greylisted: false, reason: err.message || 'Connection failed' }
    }
  }
  return { deliverable: false, greylisted: false, reason: 'Max retries' }
}

function trySMTP(mxHost: string, toEmail: string): Promise<SMTPResult> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let buffer = ''
    let step = 0
    let timeoutId: NodeJS.Timeout

    function resetTimeout() {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        socket.destroy()
        reject(new Error('Timeout'))
      }, TIMEOUT)
    }

    function send(line: string) {
      socket.write(line + '\r\n')
    }

    function onData(data: Buffer) {
      buffer += data.toString()
      const lines = buffer.split('\r\n')
      buffer = ''

      for (const line of lines) {
        if (!line) continue

        const code = parseInt(line.slice(0, 3), 10)
        const isLast = line[3] === ' '
        const msg = line.slice(4)

        if (!isLast) continue

        if (code === 220 && step === 0) {
          step = 1
          send(`HELO ${HELO_DOMAIN}`)
        } else if (code === 250 && step === 1) {
          step = 2
          send(`MAIL FROM:<${FROM_EMAIL}>`)
        } else if ((code === 250 || code === 251) && step === 2) {
          step = 3
          send(`RCPT TO:<${toEmail}>`)
        } else if (step === 3) {
          socket.destroy()
          if (code === 250) {
            resolve({ deliverable: true, greylisted: false, reason: `${code} ${msg}` })
          } else if (code === 450 || code === 451) {
            resolve({ deliverable: false, greylisted: true, reason: `${code} ${msg}` })
          } else if (code === 550 || code === 551 || code === 552 || code === 553 || code === 554) {
            resolve({ deliverable: false, greylisted: false, reason: `${code} ${msg}` })
          } else {
            resolve({ deliverable: false, greylisted: false, reason: `${code} ${msg}` })
          }
          return
        } else if (code >= 400 && code < 500 && step < 3) {
          socket.destroy()
          resolve({ deliverable: false, greylisted: true, reason: `${code} ${msg}` })
          return
        } else if (code >= 500 && step < 3) {
          socket.destroy()
          resolve({ deliverable: false, greylisted: false, reason: `${code} ${msg}` })
          return
        }
        resetTimeout()
      }
    }

    resetTimeout()
    socket.connect(SMTP_PORT, mxHost, () => {
      // Banner will be received via onData
    })
    socket.on('data', onData)
    socket.on('error', (err) => {
      clearTimeout(timeoutId)
      reject(err)
    })
    socket.on('close', () => clearTimeout(timeoutId))
  })
}
