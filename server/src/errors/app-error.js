export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', options) {
    super(message, options)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
  }
}
