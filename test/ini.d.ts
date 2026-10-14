// The `ini` package ships no types. Only the two functions the tests use.
declare module 'ini' {
  export function parse(text: string): unknown;
  export function stringify(value: object): string;
}
