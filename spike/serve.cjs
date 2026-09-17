/**
 * T0 Spike 本地静态服务器（仅开发用）。
 * 启动：node spike/serve.js [端口]，默认 8931。
 * 功能：以 spike 目录为根提供静态文件服务。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const root = __dirname
const port = Number(process.argv[2] || 8931)

// MIME 映射（spike 只用到 html/js）
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

http
  .createServer((req, res) => {
    // URL 路径 → 文件路径（禁止目录穿越）
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '')
    const file = path.join(root, rel === '' ? 'index.html' : rel)
    if (!file.startsWith(root)) {
      res.writeHead(403)
      return res.end('forbidden')
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404)
        return res.end('not found')
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(data)
    })
  })
  .listen(port, () => console.log('spike server on http://localhost:' + port))
