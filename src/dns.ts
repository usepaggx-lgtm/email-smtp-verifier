import * as dns from 'dns'

export async function resolveMX(domain: string): Promise<string[]> {
  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) return resolve([])
      addresses.sort((a, b) => a.priority - b.priority)
      resolve(addresses.map(a => a.exchange))
    })
  })
}
