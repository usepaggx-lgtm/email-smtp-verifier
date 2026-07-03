import * as net from 'net'
import * as tls from 'tls'

const HELO_DOMAIN = 'mail.emailvalidator.dev'
const FROM_EMAIL = 'noreply@emailvalidator.dev'
const TIMEOUT = 10000

const PORTS = [
  { port: 25, secure: false, starttls: false },
  { port: 587, secure: false, starttls: true },
  { port: 465, secure: true, starttls: false },
  { port: 2525, secure: false, starttls: false },
]

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
  const errors: string[] = []

  for (const { port, secure, starttls } of PORTS) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await trySMTP(mxHost, port, secure, starttls, toEmail)
        if (result.greylisted && attempt < retries) {
          await sleep(3000)
          continue
        }
        return result
      } catch (err: any) {
        const msg = err.message || String(err)
        if (attempt < retries) {
          await sleep(2000)
          continue
        }
        errors.push(`port ${port}: ${msg}`)
      }
    }
  }

  return { deliverable: false, greylisted: false, reason: `All ports failed: ${errors.join('; ')}` }
}

function trySMTP(
  mxHost: string,
  port: number,
  secure: boolean,
  starttls: boolean,
  toEmail: string
): Promise<SMTPResult> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket | tls.TLSSocket
    let buffer = ''
    let step = 0
    let tlsUpgraded = false
    let timeoutId: NodeJS.Timeout

    function resetTimeout() {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        safeDestroy()
        reject(new Error('Timeout'))
      }, TIMEOUT)
    }

    function safeDestroy() {
      try { socket.destroy() } catch {}
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
          if (starttls && !tlsUpgraded) {
            send('EHLO ' + HELO_DOMAIN)
          } else {
            send(`HELO ${HELO_DOMAIN}`)
          }
        } else if (code === 250 && step === 1) {
          if (starttls && !tlsUpgraded) {
            if (msg.toUpperCase().includes('STARTTLS')) {
              step = 0
              send('STARTTLS')
            } else {
              safeDestroy()
              resolve({ deliverable: false, greylisted: false, reason: 'STARTTLS not supported' })
              return
            }
          } else {
            step = 2
            send(`MAIL FROM:<${FROM_EMAIL}>`)
          }
        } else if (code === 220 && starttls && !tlsUpgraded && step === 0) {
          const tlsSocket = tls.connect({ socket: socket as net.Socket, servername: mxHost })
          socket = tlsSocket
          tlsUpgraded = true
          step = 0
          buffer = ''
          tlsSocket.on('data', onData)
          tlsSocket.on('error', (err) => { safeDestroy(); reject(err) })
          resetTimeout()
          return
        } else if ((code === 250 || code === 251) && step === 2) {
          step = 3
          send(`RCPT TO:<${toEmail}>`)
        } else if (step === 3) {
          safeDestroy()
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
          safeDestroy()
          resolve({ deliverable: false, greylisted: true, reason: `${code} ${msg}` })
          return
        } else if (code >= 500 && step < 3) {
          safeDestroy()
          resolve({ deliverable: false, greylisted: false, reason: `${code} ${msg}` })
          return
        }
        resetTimeout()
      }
    }

    resetTimeout()

    if (secure) {
      socket = tls.connect({ host: mxHost, port, servername: mxHost }, () => {})
    } else {
      socket = new net.Socket()
      socket.connect(port, mxHost, () => {})
    }

    socket.on('data', onData)
    socket.on('error', (err) => {
      clearTimeout(timeoutId)
      reject(err)
    })
    socket.on('close', () => clearTimeout(timeoutId))
  })
}
