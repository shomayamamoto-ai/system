# 面談・相談予約システムを動かすための入れ物（コンテナ）の作り方
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# 先に部品（nodemailer）だけ入れておくと、プログラムを直したときの作り直しが速い
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

# データは /data に保存する（コンテナを作り直しても消えないよう、外の保存場所をつなぐ）
ENV DATA_FILE=/data/db.json PORT=3000
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 3000

# 30秒ごとに動いているか確認する
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
