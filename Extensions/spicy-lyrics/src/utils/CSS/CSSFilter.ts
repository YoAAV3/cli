type CSSFilterOptions = {
  blur?: number | string;
  brightness?: number | string;
  contrast?: number | string;
  grayscale?: number | string;
  hueRotate?: number | string;
  invert?: number | string;
  opacity?: number | string;
  saturate?: number | string;
  sepia?: number | string;
};

function CSSFilter(filters: CSSFilterOptions | string, imageUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.src = imageUrl;

    image.onload = () => {
      // Create a canvas and set its size to the image's natural dimensions
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        reject("Failed to get canvas context.");
        return;
      }

      canvas.width = image.naturalWidth; // Use natural width for accurate scaling
      canvas.height = image.naturalHeight; // Use natural height for accurate scaling

      // Build the filter string
      let filterString = "";

      if (typeof filters === "string") {
        // If it's already a string (e.g., "blur(2px), brightness(0.8)")
        filterString = filters;
      } else {
        // If it's an object, convert it to a filter string
        const filterEntries = Object.entries(filters);
        filterString = filterEntries.map(([key, value]) => `${key}(${value})`).join(", ");
      }

      // Apply the filter using the ctx.filter property
      ctx.filter = filterString;

      // Draw the image onto the canvas with the filter applied
      ctx.drawImage(image, 0, 0);

      // Create a blob from the canvas content and return a URL for it
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          resolve(url);
        } else {
          reject("Failed to create blob URL.");
        }
      }, "image/png");
    };

    image.onerror = () => reject("Image failed to load.");
  });
}

export default CSSFilter;
