const { spawn } = require("child_process");
const http = require("http");

const defaultPort = 4300 + Math.floor(Math.random() * 1000);
const port = Number(process.env.SMOKE_PORT || defaultPort);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 30000);

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error("request timeout"));
    });
  });
}

async function waitForApi(url, timeout) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeout) {
    try {
      const status = await requestStatus(url);
      if (status >= 200 && status < 300) return;
      lastError = new Error(`HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }

  throw new Error(
    `API non joignable dans le délai (${timeout} ms): ${lastError ? lastError.message : "inconnu"}`
  );
}

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      SKIP_WHATSAPP_INIT: "1",
      WA_CLIENT_ID: `smoke-${Date.now()}`,
    };

    const child = spawn(process.execPath, ["index.js"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let combinedLogs = "";

    const onData = (chunk) => {
      const line = chunk.toString();
      combinedLogs += line;
      process.stdout.write(line);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const finalize = (err) => {
      if (settled) return;
      settled = true;
      child.kill();
      if (err) reject(err);
      else resolve();
    };

    child.on("exit", (code) => {
      if (settled) return;
      const message = `Le serveur s'est arrêté prématurément (code ${code}).\n${combinedLogs}`;
      finalize(new Error(message));
    });

    (async () => {
      try {
        await waitForApi(`http://127.0.0.1:${port}/api/status`, timeoutMs);
        finalize();
      } catch (error) {
        finalize(error);
      }
    })();
  });
}

run()
  .then(() => {
    console.log(`Smoke test OK: API joignable sur le port ${port}.`);
  })
  .catch((error) => {
    console.error("Smoke test KO:", error.message);
    process.exit(1);
  });
