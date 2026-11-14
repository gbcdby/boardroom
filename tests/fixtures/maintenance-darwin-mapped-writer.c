/* Controlled test child: retain a writable mapping after closing its file descriptor. */
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1], O_RDWR | O_NOFOLLOW);
  struct stat info;
  if (fd < 0 || fstat(fd, &info) != 0 || info.st_size <= 0) return 3;
  void *region = mmap(NULL, (size_t)info.st_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  close(fd);
  if (region == MAP_FAILED) return 4;
  puts("mapped"); fflush(stdout);
  while (getchar() != EOF) { }
  return munmap(region, (size_t)info.st_size) == 0 ? 0 : 5;
}
