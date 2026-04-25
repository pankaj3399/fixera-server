export async function presignBodyImages(html: string, _expiresIn?: number): Promise<string> {
  return html;
}

export async function presignCmsDoc<T extends Record<string, any>>(doc: T, _expiresIn?: number): Promise<T> {
  return doc;
}

export async function presignCmsDocs<T extends Record<string, any>>(docs: T[], _expiresIn?: number): Promise<T[]> {
  return docs;
}
