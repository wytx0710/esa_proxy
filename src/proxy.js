// HTTP 头值必须是合法 ByteString（Latin1，U+0100 及以上的字符会抛 "not a valid ByteString"），
// 同时禁止 CR/LF 以防头注入。复制/透传任何头之前先清洗一遍。
function toValidHeaderValue(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/[^\u0009\u0020-\u00FF]/g, '');
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ==========================================
    // OPTIONS 预检：CORS 全开放，不限制任何来源
    // ==========================================
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    // ==========================================
    // 📜 封装：异常通道的 HTML 错误提示
    // ==========================================
    const getErrorResponse = (statusCode = 400, errorMessage = '') => {
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>ESA Proxy Gateway - Error</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { background: #1e1e1e; color: #ced4da; font-family: 'Courier New', Courier, monospace; padding: 20px; line-height: 1.5; }
        .container { max-width: 800px; margin: 40px auto; background: #252526; padding: 30px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
        .error-box { color: #e74c3c; font-weight: bold; font-size: 16px; margin-bottom: 20px; }
        pre { white-space: pre-wrap; word-wrap: break-word; color: #f1c40f; font-size: 14px; margin: 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-box">⚠️ 网关异常提示</div>
        <pre>${errorMessage}</pre>
    </div>
</body>
</html>`;
      return new Response(htmlContent, {
        status: statusCode,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Frame-Options': 'DENY'
        }
      });
    };

    // ==========================================
    // 1. 提取目标 URL 与自定义伪装域名逻辑
    // ==========================================
    let rawPath = url.pathname.slice(1);
    let customRefererHost = '';
    const customHostRegex = /^([a-zA-Z0-9][-a-zA-Z0-9]{0,62}(?:\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+)\/(https?:\/.*)$/i;
    const match = rawPath.match(customHostRegex);

    let targetUrlStr;
    if (match) {
      customRefererHost = match[1];
      targetUrlStr = match[2] + url.search;
    } else {
      targetUrlStr = rawPath + url.search;
    }

    // 修复非标准双斜杠
    if (targetUrlStr.startsWith('https:/') && !targetUrlStr.startsWith('https://')) {
      targetUrlStr = targetUrlStr.replace('https:/', 'https://');
    } else if (targetUrlStr.startsWith('http:/') && !targetUrlStr.startsWith('http://')) {
      targetUrlStr = targetUrlStr.replace('http:/', 'http://');
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch (e) {
      return getErrorResponse(400, '目标 URL 解析失败，结构残缺。请检查请求地址。');
    }

    // ==========================================
    // 2. 禁止代理自身（防无限递归）
    // ==========================================
    if (targetUrl.hostname === url.hostname) {
      return getErrorResponse(403, '禁止代理自身域名，请勿套娃。');
    }

    // ==========================================
    // 3. 请求方法白名单
    // ==========================================
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      return new Response('Method Not Allowed By Proxy Gateway', { status: 405 });
    }

    // ==========================================
    // 3. 多层级 IP 嗅探（ESA：request.info.remote_addr 为首选）
    // ==========================================
    let foundIp = 'Unknown_IP';
    try {
      if (request.info && request.info.remote_addr) {
        foundIp = request.info.remote_addr;
      } else {
        // 回退到通用的代理头嗅探
        const xff = request.headers.get('X-Forwarded-For');
        const realIp = request.headers.get('Ali-Cdn-Real-Ip') || request.headers.get('X-Real-IP');
        if (xff) foundIp = xff.split(',')[0].trim();
        else if (realIp) foundIp = realIp.trim();
      }
    } catch (ipError) {
      foundIp = 'Unknown_IP';
    }

    const clientIp = foundIp;
    const upstreamIp = clientIp !== 'Unknown_IP' ? `${clientIp}, 127.0.0.1` : 'Not Sent';

    // 基础请求头模板（不设 Cache-Control，让上游 CDN 正常缓存视频等大文件）
    const baseHeaders = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
      'Connection': 'keep-alive'
    };

    const passHeaders = ['accept', 'accept-encoding', 'accept-language', 'range'];

    // ==========================================
    // 4. 构建上游请求头（重构：返回 { headers, debug } 消除副作用）
    // ==========================================
    const buildHeaders = (mode) => {
      const headers = new Headers(baseHeaders);
      const debug = { referer: '', ua: '' };

      // UA 透传
      const clientUserAgent = request.headers.get('User-Agent');
      if (clientUserAgent && clientUserAgent.trim() !== '') {
        headers.set('User-Agent', toValidHeaderValue(clientUserAgent));
        debug.ua = clientUserAgent;
      } else {
        const fallbackUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
        headers.set('User-Agent', fallbackUA);
        debug.ua = fallbackUA + ' (Fallback)';
      }

      // 透传关键头
      for (const header of passHeaders) {
        const value = request.headers.get(header);
        if (value) headers.set(header, toValidHeaderValue(value));
      }

      // IP 伪装头
      if (clientIp && clientIp !== 'Unknown_IP') {
        headers.set('X-Forwarded-For', upstreamIp);
        headers.set('X-Real-IP', clientIp);
        headers.set('Client-Ip', clientIp);
        headers.set('True-Client-Ip', clientIp);
      }

      // 三种头策略
      if (customRefererHost) {
        // 用户指定伪装域名模式
        debug.referer = `https://${customRefererHost}/ (Forced by User)`;
        headers.set('Referer', `https://${customRefererHost}/`);
        headers.set('Origin', `https://${customRefererHost}`);
        headers.set('Host', targetUrl.host);
      } else if (mode === 'disguise') {
        // 自动伪装模式：伪装为目标源自身
        debug.referer = targetUrl.origin + '/ (Auto Disguise Mode)';
        headers.set('Referer', targetUrl.origin + '/');
        headers.set('Origin', targetUrl.origin);
        headers.set('Host', targetUrl.host);
      } else {
        // Clean 模式：无伪装
        debug.referer = 'None (Clean Mode)';
        headers.set('Host', targetUrl.host);
      }

      return { headers, debug };
    };

    // ==========================================
    // 5. 构建构造代理 URL 的辅助函数（用于重定向改写）
    // ==========================================
    const buildProxyUrl = (locationUrl, withDisguise) => {
      let prefix;
      if (withDisguise && customRefererHost) {
        prefix = url.origin + '/' + customRefererHost + '/';
      } else {
        prefix = url.origin + '/';
      }
      return prefix + locationUrl;
    };

    // ==========================================
    // 6. 主请求 + 智能重试
    // ==========================================
    const FETCH_TIMEOUT_CLEAN = 30000;     // Clean 模式超时（30秒，兼容慢速视频源）
    const FETCH_TIMEOUT_DISGUISE = 30000;  // Disguise 模式超时
    const ANTI_HOTLINK_CODES = [403, 401, 451, 404]; // 防盗链状态码（含 404 伪装不存在）

    const doFetch = () => {
      const options = {
        method: request.method,
        redirect: 'manual',
      };
      // POST 请求体透传
      if (request.method === 'POST') {
        options.body = request.body;
      }
      return options;
    };

    const fetchWithTimeout = async (fetchOptions, headersDebug, timeoutMs, label) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(targetUrl.href, {
          ...fetchOptions,
          headers: headersDebug.headers,
          signal: controller.signal,
        });
        return { response, debug: headersDebug.debug, aborted: false };
      } catch (err) {
        if (err.name === 'AbortError') {
          return { response: null, debug: headersDebug.debug, aborted: true, label };
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      const fetchOptions = doFetch();

      // 第一步：Clean 模式（带超时）
      const cleanHeaders = buildHeaders('clean');
      let result = await fetchWithTimeout(fetchOptions, cleanHeaders, FETCH_TIMEOUT_CLEAN, 'clean');

      let finalDebug;
      let usedMode = 'clean';

      if (result.aborted) {
        return getErrorResponse(504, 'Clean 模式请求超时，目标服务器响应过慢。');
      }

      finalDebug = result.debug;
      let response = result.response;

      // 智能重试：仅在非伪装域名模式 + 防盗链状态码时，切换到 Disguise 模式
      if (!customRefererHost && ANTI_HOTLINK_CODES.includes(response.status)) {
        const disguiseHeaders = buildHeaders('disguise');
        const disguiseFetchOptions = doFetch();
        result = await fetchWithTimeout(disguiseFetchOptions, disguiseHeaders, FETCH_TIMEOUT_DISGUISE, 'disguise');

        if (result.aborted) {
          return getErrorResponse(504, 'Disguise 模式请求超时，目标服务器响应过慢。');
        }

        finalDebug = result.debug;
        response = result.response;
        usedMode = 'disguise';
      }

      // ==========================================
      // 7. 301/302 重定向改写：隐藏真实目标
      // ==========================================
      const redirectStatuses = [301, 302, 307, 308];
      if (redirectStatuses.includes(response.status)) {
        const location = response.headers.get('Location');
        if (location) {
          const rewritten = buildProxyUrl(location, usedMode === 'disguise');
          const redirectHeaders = new Headers();
          redirectHeaders.set('Location', toValidHeaderValue(rewritten));
          redirectHeaders.set('Access-Control-Allow-Origin', '*');
          redirectHeaders.set('Access-Control-Expose-Headers', 'Location');
          return new Response(null, {
            status: response.status,
            statusText: toValidHeaderValue(response.statusText),
            headers: redirectHeaders,
          });
        }
      }

      // ==========================================
      // 8. 包装并输出最终响应
      // ==========================================
      const responseHeaders = new Headers();
      const headersToCopy = [
        'content-type', 'content-length', 'content-range',
        'accept-ranges', 'cache-control', 'expires',
        'last-modified', 'etag', 'content-disposition',
        'content-encoding',
      ];

      for (const header of headersToCopy) {
        const value = response.headers.get(header);
        if (value) responseHeaders.set(header, toValidHeaderValue(value));
      }

      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
      responseHeaders.delete('Set-Cookie');

      // 调试响应头（保留完整的调试信息）
      responseHeaders.set('X-Debug-Fake-Referer', toValidHeaderValue(finalDebug.referer));
      responseHeaders.set('X-Debug-Upstream-IP', upstreamIp);
      responseHeaders.set('X-Debug-Upstream-UA', toValidHeaderValue(finalDebug.ua));
      responseHeaders.set('X-Debug-Proxy-Status', `${usedMode} -> Layer-1: ${response.status}`);
      responseHeaders.set('Access-Control-Expose-Headers',
        'X-Debug-Fake-Referer, X-Debug-Upstream-IP, X-Debug-Upstream-UA, X-Debug-Proxy-Status, Content-Range, Content-Disposition');

      return new Response(response.body, {
        status: response.status,
        statusText: toValidHeaderValue(response.statusText),
        headers: responseHeaders
      });

    } catch (error) {
      return getErrorResponse(500, `网关异常通道触发: ${error.message}`);
    }
  }
};
