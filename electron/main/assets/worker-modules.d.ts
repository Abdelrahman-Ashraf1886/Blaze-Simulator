// electron-vite builds `./x?modulePath` as its own bundle and resolves to that file's path.
declare module '*?modulePath' {
  const path: string
  export default path
}
