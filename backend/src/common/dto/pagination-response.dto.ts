export class PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;

  static create<T>(data: T[], total: number, page: number, limit: number): PaginatedResponse<T> {
    const response = new PaginatedResponse<T>();
    response.data = data;
    response.meta = {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
    return response;
  }
}
