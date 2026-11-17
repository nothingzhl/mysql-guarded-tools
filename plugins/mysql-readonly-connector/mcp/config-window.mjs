import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const allowed = new Set(['mysql_list_connections', 'mysql_save_connection', 'mysql_delete_connection', 'mysql_set_default_connection', 'mysql_health_check']);
export function createConfigWindow({ callTool, htmlUrl = new URL('../ui/config.html', import.meta.url) }) {
  let server, token, origin;
  let mutation = false;
  function equalToken(value) {
    const a = Buffer.from(value || ''); const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  function send(res, status, data, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  }
  async function handle(req, res) {
    try {
      if (req.headers.host !== new URL(origin).host) return send(res,403,{error:'无效的本机访问地址'});
      if (req.headers.origin && req.headers.origin !== origin) return send(res,403,{error:'拒绝跨站访问'});
      if (req.method === 'GET' && req.url === '/') return send(res,200,await readFile(htmlUrl,'utf8'),'text/html');
      if (req.method !== 'POST' || req.url !== '/api') return send(res,404,{error:'接口不存在'});
      if (!equalToken(req.headers.authorization?.replace(/^Bearer /,''))) return send(res,401,{error:'窗口授权已失效，请重新打开配置窗口'});
      if (!req.headers['content-type']?.startsWith('application/json')) return send(res,415,{error:'需要 JSON 请求'});
      let body='';
      for await (const chunk of req) { body+=chunk; if(Buffer.byteLength(body)>16384) return send(res,413,{error:'请求过大'}); }
      const { tool, args = {} } = JSON.parse(body);
      if (!allowed.has(tool)) return send(res,403,{error:'配置窗口不支持此操作'});
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k=>/password/i.test(k)&&!['password_source','password_key'].includes(k))) return send(res,400,{error:'不得通过窗口传递密码'});
      const modifying=['mysql_save_connection','mysql_delete_connection','mysql_set_default_connection'].includes(tool);
      if (modifying && mutation) return send(res,409,{error:'另一项配置操作尚未完成，请稍后重试'});
      if(modifying) mutation=true;
      try { send(res,200,{result:await callTool(tool,args)}); }
      finally { if(modifying) mutation=false; }
    } catch(error) { send(res,400,{error:error.message || '操作失败'}); }
  }
  return {
    async open() {
      if (!server) {
        token=randomBytes(32).toString('hex');
        server=http.createServer((req,res)=>void handle(req,res));
        server.requestTimeout=150000;
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
        origin=`http://127.0.0.1:${server.address().port}`;
      }
      return {url:`${origin}/#${token}`,message:'在浏览器打开此本机配置窗口。此窗口操作真实连接；关闭插件后地址失效。'};
    },
    async close() { if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;} },
  };
}
