declare module "tree-kill" {
  function kill(
    pid: number,
    signal?: string,
    callback?: (err?: Error) => void,
  ): void;
  export = kill;
}
