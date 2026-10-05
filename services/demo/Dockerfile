FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

USER node
EXPOSE 8080

# --expose-gc lets /admin/restart release leaked memory right away.
CMD ["node", "--expose-gc", "src/server.js"]
