#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Test-only lifecycle fixture. No source path, source FD, network or command input. */
static pthread_t leader;
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t ready = PTHREAD_COND_INITIALIZER;
static long worker_tid;
static size_t worker_stack;
static const int resources[] = { RLIMIT_AS, RLIMIT_CPU, RLIMIT_CORE, RLIMIT_NOFILE, RLIMIT_FSIZE };
static const rlim_t bounds[] = { 64 * 1024 * 1024, 5, 0, 16, 1024 * 1024 };
static struct rlimit actual[5];

static void stop(const char *phase) {
    char message[128];
    int length = snprintf(message, sizeof(message), "thread-exit fixture failed: %s\n", phase);
    if (length > 0 && (size_t)length < sizeof(message)) (void)write(STDERR_FILENO, message, (size_t)length);
    _exit(70);
}
static void send_event(const char *phase) {
    char message[1024];
    int length = snprintf(message, sizeof(message),
        "{\"phase\":\"%s\",\"pid\":%ld,\"leaderTid\":%ld,\"workerTid\":%ld,\"uid\":%ld,\"gid\":%ld,"
        "\"workerStack\":%zu,\"limits\":{\"as\":[%llu,%llu],\"cpu\":[%llu,%llu],\"core\":[%llu,%llu],"
        "\"nofile\":[%llu,%llu],\"fsize\":[%llu,%llu]}}\n",
        phase, (long)getpid(), (long)getpid(), worker_tid, (long)getuid(), (long)getgid(), worker_stack,
        (unsigned long long)actual[0].rlim_cur, (unsigned long long)actual[0].rlim_max,
        (unsigned long long)actual[1].rlim_cur, (unsigned long long)actual[1].rlim_max,
        (unsigned long long)actual[2].rlim_cur, (unsigned long long)actual[2].rlim_max,
        (unsigned long long)actual[3].rlim_cur, (unsigned long long)actual[3].rlim_max,
        (unsigned long long)actual[4].rlim_cur, (unsigned long long)actual[4].rlim_max);
    if (length <= 0 || (size_t)length >= sizeof(message)) stop("event-size");
    size_t sent = 0;
    while (sent < (size_t)length) {
        ssize_t count = write(STDOUT_FILENO, message + sent, (size_t)length - sent);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) stop("event-write");
        sent += (size_t)count;
    }
}
static void command(int fd, char expected) {
    char value;
    ssize_t count;
    do { count = read(fd, &value, 1); } while (count < 0 && errno == EINTR);
    if (count != 1 || value != expected) stop("control-command");
}
static void *worker_main(void *unused) {
    (void)unused;
    pthread_attr_t attributes;
    size_t stack;
    if (pthread_getattr_np(pthread_self(), &attributes) || pthread_attr_getstacksize(&attributes, &stack)) stop("actual-stack");
    if (pthread_attr_destroy(&attributes) || stack != 256 * 1024) stop("stack-bound");
    if (pthread_mutex_lock(&mutex)) stop("worker-mutex");
    worker_tid = syscall(SYS_gettid); worker_stack = stack;
    if (pthread_cond_signal(&ready) || pthread_mutex_unlock(&mutex)) stop("worker-ready");
    if (pthread_join(leader, NULL)) stop("join-leader");
    send_event("LEADER_JOINED");
    command(3, 'Q');
    send_event("DONE");
    return NULL;
}
int main(int argc, char **argv) {
    (void)argv;
    sigset_t unblocked;
    if (signal(SIGALRM, SIG_DFL) == SIG_ERR || signal(SIGTERM, SIG_DFL) == SIG_ERR
        || sigemptyset(&unblocked) || sigaddset(&unblocked, SIGALRM) || sigaddset(&unblocked, SIGTERM)
        || sigprocmask(SIG_UNBLOCK, &unblocked, NULL)) stop("signal-bound");
    alarm(20);
    if (argc != 1 || getuid() == 0 || getuid() != geteuid() || getgid() != getegid()) stop("ordinary-identity");
    for (size_t index = 0; index < sizeof(resources) / sizeof(resources[0]); index++) {
        struct rlimit requested = { bounds[index], bounds[index] };
        if (setrlimit(resources[index], &requested) || getrlimit(resources[index], &actual[index])
            || actual[index].rlim_cur != bounds[index] || actual[index].rlim_max != bounds[index]) stop("resource-bound");
    }
    leader = pthread_self();
    if (syscall(SYS_gettid) != getpid()) stop("leader-identity");
    pthread_attr_t attributes;
    pthread_t worker;
    if (pthread_attr_init(&attributes) || pthread_attr_setstacksize(&attributes, 256 * 1024)
        || pthread_create(&worker, &attributes, worker_main, NULL) || pthread_attr_destroy(&attributes)) stop("create-worker");
    if (pthread_mutex_lock(&mutex)) stop("leader-mutex");
    while (!worker_tid) if (pthread_cond_wait(&ready, &mutex)) stop("ready-wait");
    if (pthread_mutex_unlock(&mutex)) stop("leader-ready");
    send_event("READY");
    command(STDIN_FILENO, 'L');
    pthread_exit(NULL);
}
