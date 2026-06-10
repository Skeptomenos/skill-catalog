export class ConfigError extends Error {
  readonly _tag = "ConfigError";
}

export class StorageError extends Error {
  readonly _tag = "StorageError";
}

export class LimitError extends Error {
  readonly _tag = "LimitError";
}

export class PathGuardError extends Error {
  readonly _tag = "PathGuardError";
}
