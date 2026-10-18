/** Retry one transient server failure without caching or extending authority. */
export async function readExperienceAuthority(current: () => boolean, read: () => Promise<Response>): Promise<Response | null> {
  if (!current()) return null;
  let response = await read();
  if (!current()) return null;
  if ([500, 502, 503, 504].includes(response.status)) {
    await new Promise<void>(resolve => setTimeout(resolve, 250));
    if (!current()) return null;
    response = await read();
  }
  return current() ? response : null;
}
export async function readExperienceAuthorityPair(current: () => boolean, live: () => Promise<Response>, exposure?: () => Promise<Response>): Promise<[Response | null, Response | null]> {
  const [response, status] = await Promise.all([
    readExperienceAuthority(current, live),
    exposure ? readExperienceAuthority(current, exposure) : Promise.resolve(null),
  ]);
  return current() ? [response, status] : [null, null];
}
