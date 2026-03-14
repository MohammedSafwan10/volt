export function computeNovelStreamText(
  incoming: string,
  accumulated: string,
): { novel: string; nextAccumulated: string } {
  if (!incoming) {
    return { novel: '', nextAccumulated: accumulated };
  }

  if (!accumulated) {
    return { novel: incoming, nextAccumulated: incoming };
  }

  if (incoming === accumulated || accumulated.endsWith(incoming)) {
    return { novel: '', nextAccumulated: accumulated };
  }

  if (incoming.startsWith(accumulated)) {
    return {
      novel: incoming.slice(accumulated.length),
      nextAccumulated: incoming,
    };
  }

  const maxOverlap = Math.min(accumulated.length, incoming.length);
  for (let size = maxOverlap; size > 0; size--) {
    if (accumulated.endsWith(incoming.slice(0, size))) {
      return {
        novel: incoming.slice(size),
        nextAccumulated: accumulated + incoming.slice(size),
      };
    }
  }

  return {
    novel: incoming,
    nextAccumulated: accumulated + incoming,
  };
}
