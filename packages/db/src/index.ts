/** SQLite is introduced behind repositories so runtime process state never leaks into persistence. */
export interface ProjectRepository { list(): Promise<readonly { id: string; path: string; name: string }[]>; }
export interface DatabaseHealth { dialect: 'sqlite'; location: string; migratedAt?: string; }
