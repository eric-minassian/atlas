/** A set of callbacks for one kind of event; `add` returns the unsubscribe. */
export class Listeners<T> {
  private readonly set = new Set<(value: T) => void>();

  add(listener: (value: T) => void): () => void {
    this.set.add(listener);
    return () => this.set.delete(listener);
  }

  emit(value: T): void {
    for (const listener of this.set) listener(value);
  }
}
