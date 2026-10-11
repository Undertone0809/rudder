import { createServer } from "node:net";

const MAX_PORT_CANDIDATES = 10;
const MAX_PORT = 65_535;

async function probePort(port: number, hostname: string): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error(`Could not resolve bound port for ${hostname}`));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, hostname);
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error);
    }
  });
}

/**
 * Select a free port on the same address the caller will bind. Keeping the
 * probe host explicit avoids enumerating unrelated interface addresses, and
 * every path is bounded: try the configured port and next nine ports, then
 * ask the OS for one ephemeral port. Only an occupied candidate is skipped;
 * address and permission errors propagate to the caller.
 */
export async function selectAvailablePort(port: number, hostname: string): Promise<number> {
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new RangeError(`Port must be an integer between 0 and ${MAX_PORT}`);
  }
  if (!hostname) throw new Error("Port selection requires the listener hostname");
  if (port === 0) return probePort(0, hostname);

  for (let offset = 0; offset < MAX_PORT_CANDIDATES && port + offset <= MAX_PORT; offset += 1) {
    const candidate = port + offset;
    try {
      return await probePort(candidate, hostname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  return probePort(0, hostname);
}
