// A loopback stand-in for the usage statistics server (docs/performance-testing.md, "Usage
// statistics on and off"): it responds to POST /api/batch as Umami does and counts what it gets.
//   node scripts/perf/analytics-mock.mjs [--port 5535] [--log <file>]
// GET /count gives { requests, items, bytes }. Each request is also appended to the log file as a
// JSON line with the event names it carried.
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const argument = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`)
    return at === -1 ? fallback : process.argv[at + 1]
}
const port = Number(argument('port', 5535))
const log = argument('log', undefined)
const totals = { requests: 0, items: 0, bytes: 0 }

const server = createServer((request, response) => {
    // The page and this server are different origins.
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'content-type')
    if (request.method === 'OPTIONS') return void response.writeHead(204).end()
    if (request.method === 'GET' && request.url === '/count')
        return void response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(totals))
    if (request.method !== 'POST' || request.url !== '/api/batch')
        return void response.writeHead(404).end()
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        let items
        try {
            items = JSON.parse(body)
        } catch {
            return void response.writeHead(400).end()
        }
        totals.requests++
        totals.items += items.length
        totals.bytes += body.length
        if (log)
            appendFileSync(
                log,
                JSON.stringify({
                    at: new Date().toISOString(),
                    bytes: body.length,
                    names: items.map((item) => item.payload?.name ?? '(pageview)'),
                }) + '\n',
            )
        response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ size: items.length, processed: items.length, errors: 0 }))
    })
})
server.listen(port, '127.0.0.1', () => {
    console.log(`Usage statistics mock on http://127.0.0.1:${port}`)
})
