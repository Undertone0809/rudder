export interface LocalAccountSessionRevocation {
  publish(userId: string): void;
  subscribe(listener: (userId: string) => void): () => void;
  generation(): number;
}

export function createLocalAccountSessionRevocation(): LocalAccountSessionRevocation {
  const listeners = new Set<(userId: string) => void>();
  let generation = 0;

  return {
    publish(userId) {
      generation += 1;
      for (const listener of listeners) listener(userId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    generation() {
      return generation;
    },
  };
}
