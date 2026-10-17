export function IsInViewport(element: HTMLElement, scrollable: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const scrollableRect = scrollable.getBoundingClientRect();

  return (
    rect.top >= scrollableRect.top &&
    rect.left >= scrollableRect.left &&
    rect.bottom <= scrollableRect.bottom &&
    rect.right <= scrollableRect.right
  );
}
