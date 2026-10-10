FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_PUBLIC_API_URL=http://localhost:8000
RUN npm run build
CMD ["npx", "next", "start", "--hostname", "0.0.0.0"]
