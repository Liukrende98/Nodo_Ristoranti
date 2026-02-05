FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Expose ports
EXPOSE 3000 3001

# Start script handles migrations, seed, and both servers
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run db:seed 2>/dev/null; npm run dev & npm run socket & wait"]
