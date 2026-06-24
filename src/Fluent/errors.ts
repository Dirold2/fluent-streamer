export class FluentStreamValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FluentStreamValidationError";
    Object.setPrototypeOf(this, FluentStreamValidationError.prototype);
  }
}
