// Local development API server — runs alongside Vite on port 3001
// Usage: node server.dev.mjs
// Vite proxies /api/* to this server automatically (see vite.config.js)

import { createServer } from 'http'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env manually (no extra dependencies needed)
try {
  const envPath = resolve(process.cwd(), '.env')
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
  console.log('✓ Loaded .env')
} catch {
  console.warn('⚠ Could not load .env file')
}

const PORT = 3001

// Generic handler for reading POST body and calling a Vercel-style handler fn
async function runHandler(handlerModule, req, res, body) {
  let statusCode = 200
  const mockRes = {
    status(code) {
      statusCode = code
      return this
    },
    json(data) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    },
  }

  const parsed = typeof body === 'string' ? JSON.parse(body || '{}') : body
  await handlerModule.default(
    { method: req.method, body: parsed, headers: req.headers, query: {} },
    mockRes
  )
}

createServer(async (req, res) => {
  // Allow cross-origin requests from Vite dev server
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Collect body for POST requests
  let body = ''
  if (req.method === 'POST') {
    await new Promise((resolve) => {
      req.on('data', (chunk) => (body += chunk))
      req.on('end', resolve)
    })
  }

  try {
    if (req.url === '/api/extract-bet' && req.method === 'POST') {
      const mod = await import(`./api/extract-bet.js?t=${Date.now()}`)
      await runHandler(mod, req, res, body)
    } else if (req.url === '/api/check-results' && (req.method === 'POST' || req.method === 'GET')) {
      console.log(`→ ${req.method} /api/check-results`)
      const mod = await import(`./api/check-results.js?t=${Date.now()}`)
      await runHandler(mod, req, res, body)
    } else if (req.url === '/api/extract-results' && req.method === 'POST') {
      console.log('→ POST /api/extract-results')
      const mod = await import(`./api/extract-results.js?t=${Date.now()}`)
      await runHandler(mod, req, res, body)
    } else if (req.url === '/api/match-weekly-multi' && req.method === 'POST') {
      console.log('→ POST /api/match-weekly-multi')
      const mod = await import(`./api/match-weekly-multi.js?t=${Date.now()}`)
      await runHandler(mod, req, res, body)
    } else if (req.url === '/api/extract-weekly-results' && req.method === 'POST') {
      console.log('→ POST /api/extract-weekly-results')
      const mod = await import(`./api/extract-weekly-results.js?t=${Date.now()}`)
      await runHandler(mod, req, res, body)
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, error: err.message }))
  }
}).listen(PORT, () => {
  console.log(`🚀 API server ready at http://localhost:${PORT}`)
  console.log('   Handling: POST /api/extract-bet')
  console.log('   Handling: POST /api/check-results  (single bet)')
  console.log('   Handling: GET  /api/check-results  (all pending — requires CRON_SECRET)')
  console.log('   Handling: POST /api/extract-results (screenshot → leg outcomes)')
})
