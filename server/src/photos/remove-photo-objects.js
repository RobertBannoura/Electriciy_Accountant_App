const missingObject = (error) => error.code === 'ENOENT' || error.name === 'NoSuchKey'

// Keep enough data to restore an image if storage or the database fails mid-delete.
export async function removePhotoObjects(storage, keys) {
  const originals = await Promise.all(keys.map(async (key) => {
    try { return await storage.get(key) } catch (error) { if (missingObject(error)) return null; throw error }
  }))
  const restore = async () => {
    await Promise.all(keys.map((key, index) => originals[index] === null ? undefined : storage.put(key, originals[index])))
  }
  try {
    for (const key of keys) await storage.remove(key)
  } catch (error) {
    await restore()
    throw error
  }
  return restore
}
