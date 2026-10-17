export function GetElementHeight(element: HTMLElement): number {
  // Get the computed styles for the ::before pseudo-element
  const beforeStyles = getComputedStyle(element, "::before");
  const afterStyles = getComputedStyle(element, "::after");

  // Parse the height values to numbers
  const beforeHeight = parseInt(beforeStyles.height) || 0;
  const afterHeight = parseInt(afterStyles.height) || 0;

  return element.offsetHeight + beforeHeight + afterHeight;
}
