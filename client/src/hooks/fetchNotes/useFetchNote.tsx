import { useQuery } from "@tanstack/react-query";
import { fetchNoteById } from "../../api/api";

export function useFetchNote(id: string) {
  return useQuery({
    queryKey: ["note_data", id],
    queryFn: () => fetchNoteById(id),
    enabled: Boolean(id) && id !== "", // Don't run if ID is falsy
    staleTime: 60 * 1000, // 1 minutes caching
    retry: 1, // One retry on failure
  });
}
