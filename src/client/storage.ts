// Browser storage that never throws (private windows, blocked site data).

function wrap(get: () => Storage): { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void } {
  return {
    get(k) {
      try {
        return get().getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        get().setItem(k, v);
      } catch {
        // storage unavailable: the value lives only until the page closes
      }
    },
    remove(k) {
      try {
        get().removeItem(k);
      } catch {
        // ignore
      }
    },
  };
}

export const storage = {
  // This tab only, survives reloads: login tokens.
  session: wrap(() => sessionStorage),
  // Preferences: last repository, serial speed.
  local: wrap(() => localStorage),
};
