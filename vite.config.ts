import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

function hmrLifecycleGuardPlugin(disableHmr: boolean): Plugin {
  return {
    name: 'dts-hmr-lifecycle-guard',
    apply: 'serve',
    transform(code, id) {
      if (!id.includes('@vite/client') && !id.endsWith('vite/dist/client/client.mjs')) {
        return null;
      }

      let patched = code;

      // 1. Expose proxy/disabled flag cleanly at top of @vite/client
      patched = `const __DTS_HMR_DISABLED__ = ${disableHmr ? 'true' : 'false'};\n` + patched;

      // 2. Buffer early sends while connecting instead of throwing SendBeforeConnectError,
      //    no-op safely when HMR is disabled, and flush buffered messages once connected.
      patched = patched.replace(
        'let isConnected = !invokeableTransport.connect;\n\tlet connectingPromise;',
        'let isConnected = !invokeableTransport.connect;\n\tlet connectingPromise;\n\tconst pendingMessages = [];'
      );

      patched = patched.replace(
        'if (maybePromise) {\n\t\t\t\tconnectingPromise = maybePromise;\n\t\t\t\tawait connectingPromise;\n\t\t\t\tconnectingPromise = void 0;\n\t\t\t}\n\t\t\tisConnected = true;',
        `if (maybePromise) {
\t\t\t\tconnectingPromise = maybePromise;
\t\t\t\ttry {
\t\t\t\t\tawait connectingPromise;
\t\t\t\t} finally {
\t\t\t\t\tconnectingPromise = void 0;
\t\t\t\t}
\t\t\t}
\t\t\tisConnected = true;
\t\t\twhile (pendingMessages.length > 0 && isConnected) {
\t\t\t\tconst nextMsg = pendingMessages.shift();
\t\t\t\ttry { await invokeableTransport.send(nextMsg); } catch {}
\t\t\t}`
      );

      patched = patched.replace(
        `if (!isConnected) {
\t\t\t\tif (connectingPromise) await connectingPromise;
\t\t\t\telse throw new SendBeforeConnectError("send was called before connect");
\t\t\t}`,
        `if (!isConnected) {
\t\t\t\tif (connectingPromise) {
\t\t\t\t\ttry { await connectingPromise; } catch { return; }
\t\t\t\t\tif (!isConnected) {
\t\t\t\t\t\tif (!__DTS_HMR_DISABLED__ && pendingMessages.length < 50) pendingMessages.push(data);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t} else {
\t\t\t\t\tif (__DTS_HMR_DISABLED__) return;
\t\t\t\t\tif (pendingMessages.length < 50) pendingMessages.push(data);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t}`
      );

      patched = patched.replace(
        `if (!isConnected) {
\t\t\t\tif (connectingPromise) await connectingPromise;
\t\t\t\telse throw new SendBeforeConnectError("invoke was called before connect");
\t\t\t}`,
        `if (!isConnected) {
\t\t\t\tif (connectingPromise) {
\t\t\t\t\ttry { await connectingPromise; } catch { return void 0; }
\t\t\t\t\tif (!isConnected) return void 0;
\t\t\t\t} else {
\t\t\t\t\treturn void 0;
\t\t\t\t}
\t\t\t}`
      );

      // 3. Clean up stale WebSocket timers/listeners on reconnect/disconnect and verify readyState === OPEN before ws.send
      patched = patched.replace(
        'async connect({ onMessage, onDisconnection }) {\n\t\t\tconst socket = options.createConnection();',
        `async connect({ onMessage, onDisconnection }) {
\t\t\tif (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = void 0; }
\t\t\tif (ws && ws.readyState < 2) { try { ws.close(); } catch {} }
\t\t\tconst socket = options.createConnection();`
      );

      patched = patched.replace(
        `socket.addEventListener("close", () => {
\t\t\t\t\tif (!isOpened) {
\t\t\t\t\t\treject(/* @__PURE__ */ new Error("WebSocket closed without opened."));
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tonMessage({
\t\t\t\t\t\ttype: "custom",
\t\t\t\t\t\tevent: "vite:ws:disconnect",
\t\t\t\t\t\tdata: { webSocket: socket }
\t\t\t\t\t});
\t\t\t\t\tonDisconnection();
\t\t\t\t});`,
        `socket.addEventListener("close", () => {
\t\t\t\t\tif (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = void 0; }
\t\t\t\t\tif (ws === socket) ws = void 0;
\t\t\t\t\tif (!isOpened) {
\t\t\t\t\t\treject(/* @__PURE__ */ new Error("WebSocket closed without opened."));
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tonMessage({
\t\t\t\t\t\ttype: "custom",
\t\t\t\t\t\tevent: "vite:ws:disconnect",
\t\t\t\t\t\tdata: { webSocket: socket }
\t\t\t\t\t});
\t\t\t\t\tonDisconnection();
\t\t\t\t}, { once: true });`
      );

      patched = patched.replace(
        'disconnect() {\n\t\t\tclearInterval(pingIntervalId);\n\t\t\tws?.close();\n\t\t}',
        `disconnect() {
\t\t\tif (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = void 0; }
\t\t\tconst prev = ws;
\t\t\tws = void 0;
\t\t\ttry { prev?.close(); } catch {}
\t\t}`
      );

      patched = patched.replace(
        'send(data) {\n\t\t\tws.send(JSON.stringify(data));\n\t\t}',
        `send(data) {
\t\t\tif (!ws || ws.readyState !== 1) return;
\t\t\tws.send(JSON.stringify(data));
\t\t}`
      );

      // 4. In HTTPS reverse-proxy previews or DISABLE_HMR=true, skip connecting WebSocket & console forwarding
      if (disableHmr) {
        patched = patched
          .replace(
            'transport.connect(createHMRHandler(handleMessage));',
            '/* HMR WebSocket connection disabled in HTTPS reverse-proxy preview */'
          )
          .replace(
            'setupForwardConsoleHandler(transport, forwardConsole);',
            '/* Console forwarding disabled when HMR WebSocket is disabled */'
          );
      }

      return {
        code: patched,
        map: null,
      };
    },
  };
}

export default defineConfig(() => {
  const isHttpsProxyOrDisabled =
    process.env.DISABLE_HMR === 'true' ||
    Boolean(process.env.K_SERVICE) ||
    Boolean(process.env.APP_URL && process.env.APP_URL.startsWith('https://'));

  return {
    plugins: [
      react(),
      tailwindcss(),
      hmrLifecycleGuardPlugin(isHttpsProxyOrDisabled),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'pwa-192x192.png',
          'pwa-512x512.png',
          'pwa-maskable-512x512.png',
          'apple-touch-icon.png',
        ],
        manifest: {
          id: '/',
          name: 'DIGI TECH SOLUTION',
          short_name: 'DIGI TECH',
          description:
            'Website Design, Development & Digital Growth Agency in Darbhanga, Bihar.',
          theme_color: '#080B12',
          background_color: '#080B12',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,jpg,jpeg,svg,webp,woff,woff2}'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
              handler: 'NetworkOnly',
            },
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      // Disable HMR and Vite WebSocket server in Cloud Run (*.run.app) / HTTPS reverse-proxy
      // environments (or when DISABLE_HMR=true), so Vite stops throwing unhandled
      // WebSocket rejection errors in the browser console.
      hmr: !isHttpsProxyOrDisabled,
      ws: isHttpsProxyOrDisabled ? (false as const) : undefined,
      watch: isHttpsProxyOrDisabled ? null : {},
    },
  };
});
