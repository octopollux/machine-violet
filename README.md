# Machine Violet

An agentic AI Dungeon Master that runs any tabletop RPG in a terminal. Powered by Claude AI and Ink.

## Tech Stack

- **Runtime**: Node.js (18+)
- **UI Framework**: Ink (React for CLI)
- **AI Engine**: Anthropic Claude SDK
- **Language**: TypeScript
- **Platforms**: Windows, macOS, Linux

## Project Structure

```
src/
  ├── components/     # Ink UI components
  ├── engine/         # Game engine core
  ├── services/       # Claude AI integration
  └── types/          # TypeScript types
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and add your Anthropic API key:
   ```bash
   cp .env.example .env
   ```

3. Get your API key from: https://console.anthropic.com/

## Development

```bash
# Run in development mode
npm run dev

# Build
npm run build

# Run production build
npm start
```

## License

MIT
