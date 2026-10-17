/**
 * Darkens a hex color by a specified percentage
 * @param color - Hex color string (e.g., "#FFFFFF")
 * @param percent - Percentage to darken (0-100)
 * @returns Darkened hex color string
 */
export function darkenColor(color: string, percent: number): string {
  // Validate input
  if (!color.startsWith("#") || (color.length !== 7 && color.length !== 4)) {
    console.warn("Invalid color format. Expected #RRGGBB or #RGB");
    return color;
  }

  // Parse RGB values
  let R = parseInt(color.substring(1, 3), 16);
  let G = parseInt(color.substring(3, 5), 16);
  let B = parseInt(color.substring(5, 7), 16);

  // Apply darkening
  R = Math.max(0, Math.floor(R * (1 - percent / 100)));
  G = Math.max(0, Math.floor(G * (1 - percent / 100)));
  B = Math.max(0, Math.floor(B * (1 - percent / 100)));

  // Convert back to hex
  return `#${((1 << 24) + (R << 16) + (G << 8) + B).toString(16).slice(1)}`;
}
