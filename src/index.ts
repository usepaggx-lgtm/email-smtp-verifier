import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { verifySMTP } from './smtp'
import { resolveMX } from './dns'

const app = new Hono()

app.use('/*', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'] }))

app.get('/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }))

app.post('/verify', async (c) => {
  try {
    const { email } = await c.req.json() as { email: string }
    if (!email || !email.includes('@')) {
      return c.json({ error: 'Invalid email' }, 400)
    }

    const domain = email.split('@')[1].toLowerCase()
    const start = Date.now()

    const mxRecords = await resolveMX(domain)
    if (!mxRecords || mxRecords.length === 0) {
      return c.json({
        deliverable: false,
        catch_all: false,
        greylisted: false,
        reason: 'No MX records',
        duration_ms: Date.now() - start,
      })
    }

    const mx = mxRecords[0]
    const result = await verifySMTP(mx, email, domain, 2)

    let catchAll = false
    if (result.deliverable) {
      const randomUser = `nobody${Date.now()}${Math.random().toString(36).slice(2, 6)}`
      const catchResult = await verifySMTP(mx, `${randomUser}@${domain}`, domain, 1)
      catchAll = catchResult.deliverable
    }

    return c.json({
      deliverable: result.deliverable,
      catch_all: catchAll,
      greylisted: result.greylisted,
      reason: result.reason,
      duration_ms: Date.now() - start,
    })
  } catch (err: any) {
    return c.json({ error: err.message || 'SMTP verification failed' }, 500)
  }
})

const port = parseInt(process.env.PORT || '3001')
console.log(`SMTP Verifier starting on port ${port}`)
serve({ fetch: app.fetch, port })
console.log(`SMTP Verifier running on port ${port}`)
