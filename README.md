# Idle-game-radar

Find good games.

## Running locally

```bash
npm install
npm start
```

Set a [`RAWG_KEY`](https://rawg.io/apidocs) environment variable to query the live RAWG API:

```bash
RAWG_KEY=your_api_key npm start
```

Without a key the server now falls back to the offline sample dataset stored at
`data/sample-rawg-response.json`. This keeps the UI usable in local development
environments, while `/api/health` reports whether the live key or the offline
sample is available.
