FROM docker.io/library/node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9657 \
    NON_INTERACTIVE=1 \
    KIMI_AUTH_PATH=/run/secrets/kimi-auth.json \
    PROXY_API_KEY_FILE=/run/secrets/proxy-api-key \
    REQUIRE_PROXY_API_KEY=1

WORKDIR /app

# FreeKimiAPI has no npm dependencies. Copy only what the proxy needs; browser
# auth helpers and credentials stay on the host.
COPY --chown=1000:1000 package.json server.js ./
COPY --chown=1000:1000 lib/env.js ./lib/

USER 1000:1000

EXPOSE 9657

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "const http=require('http');const req=http.get({host:'127.0.0.1',port:process.env.PORT||9657,path:'/health'},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1)})"]

CMD ["node", "server.js"]
