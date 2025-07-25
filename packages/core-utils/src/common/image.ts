export function findAppropriateImage<T extends { width: number, height: number }> (images: T[], wantedWidth: number) {
  const imagesSorted = images.sort((a, b) => a.width - b.width)

  for (const image of imagesSorted) {
    if (image.width >= wantedWidth) {
      return image
    }
  }

  return images[images.length - 1] // Biggest one
}
