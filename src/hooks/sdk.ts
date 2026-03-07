export function unwrapData<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value)) {
    return value as T;
  }

  if (typeof value === "object" && value !== null && "data" in value) {
    const data = (value as { data?: unknown }).data;
    if (data !== undefined) {
      return data as T;
    }
  }

  return fallback;
}

export function safeCreateHook<T>(name: string, factory: () => T): T | undefined {
  try {
    return factory();
  } catch (error) {
    console.warn(`[opencode-pair-autonomy] Failed to create hook ${name}:`, error);
    return undefined;
  }
}

export function safeHook<T extends (...args: any[]) => Promise<void> | void>(name: string, hook?: T): T | undefined {
  if (!hook) {
    return undefined;
  }

  return (async (...args: Parameters<T>) => {
    try {
      await hook(...args);
    } catch (error) {
      console.warn(`[opencode-pair-autonomy] Hook ${name} failed:`, error);
    }
  }) as T;
}
