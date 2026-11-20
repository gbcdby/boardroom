/* 只由 f4-cfp2-worker.c 包含。固定 guest 的 raw collector；不会为 NAPI
 * 绑定提供替身。完整事实在本次 FD 上读取，严格消费者再次关联外层来源。 */
#ifndef BOARDROOM_F4_CFP2_OBSERVE_H
#define BOARDROOM_F4_CFP2_OBSERVE_H

static bool f4_context_room(f4_state *s) {
  if (!f4_charge(s)) return false;
  if (s->context_calls >= MAX_CONTEXT_CALLS-CONTEXT_CALL_RESERVE) return f4_error(s,EOVERFLOW);
  s->context_calls++;
  return true;
}
static bool f4_raw(f4_state *s,const char *stage,const char *pass,const char *name,
                    int fd,const void *bytes,size_t length,bool stable) {
  if (length>MAX_CONTEXT_BYTES-s->context_bytes) return f4_error(s,EOVERFLOW);
  s->context_bytes+=length;
  if (stable) {
    f4_saved_fact *saved=NULL;
    for (size_t i=0;i<s->saved_count;i++) if (!strcmp(s->saved[i].name,name)) {saved=&s->saved[i];break;}
    if (saved) {
      if (saved->length!=length || (length && memcmp(saved->bytes,bytes,length))) return f4_error(s,ESTALE);
    } else {
      if (s->saved_count>=sizeof(s->saved)/sizeof(s->saved[0]) || strlen(name)>=sizeof(s->saved[0].name))
        return f4_error(s,EOVERFLOW);
      saved=&s->saved[s->saved_count++];strcpy(saved->name,name);saved->length=length;
      saved->bytes=malloc(length?length:1);
      if (!saved->bytes) return f4_error(s,ENOMEM);
      if (length) memcpy(saved->bytes,bytes,length);
    }
  }
  size_t at=0;
  do {
    size_t count=length-at;if(count>8192)count=8192;
    char hex[16385];f4_hex((const unsigned char *)bytes+at,count,hex);
    if (!f4_emit(s,"raw","aux",fd,0,0,"{\"stage\":\"%s\",\"pass\":\"%s\",\"name\":\"%s\","
      "\"offset\":%zu,\"total\":%zu,\"hex\":\"%s\",\"last\":%s}",stage,pass,name,at,length,hex,
      at+count==length?"true":"false")) return false;
    at+=count;
  } while(at<length);
  return f4_charge(s);
}
static bool f4_aux_close(f4_state *s,int *fd,const char *name) {
  if (*fd<0) return true;
  const int original=*fd;bool unknown=false,ran=false;int saved=0,rc=0,error=0;
  worker_close_slot(fd,&unknown,&saved,&ran,&rc,&error);
  if(ran)s->aux_closes++;
  f4_emit(s,"aux-close","aux",original,rc,error,"{\"name\":\"%s\",\"ran\":%s,\"unknown\":%s}",
    name,ran?"true":"false",unknown?"true":"false");
  if(unknown)s->unknown_aux++;
  if(error || !ran){if(!s->cleanup_error)s->cleanup_error=error?error:EIO;return f4_error(s,error);}
  return true;
}
static int f4_aux_open(f4_state *s,const char *path,int flags,long magic,const char *name) {
  if(!f4_context_room(s))return -1;
  errno=0;int fd=open(path,flags|O_CLOEXEC),error=fd<0?errno:0;
  if(fd>=0)s->aux_opens++;
  char hex[MAX_PATH_BYTES*2+1];size_t length=strlen(path);
  if(length>MAX_PATH_BYTES){f4_error(s,EOVERFLOW);if(fd>=0)f4_aux_close(s,&fd,name);return -1;}
  f4_hex(path,length,hex);
  f4_emit(s,"aux-open","aux",fd,fd<0?-1:0,error,"{\"name\":\"%s\",\"path_hex\":\"%s\",\"flags\":%d}",name,hex,flags|O_CLOEXEC);
  if(error){f4_error(s,error);return -1;}
  struct stat st={0};struct statfs fs={0};
  if(!f4_context_room(s) || fstat(fd,&st) || !f4_context_room(s) || fstatfs(fd,&fs) || fs.f_type!=magic) {
    f4_error(s,errno?errno:ESTALE);f4_aux_close(s,&fd,name);return -1;
  }
  f4_emit(s,"aux-stat","aux",fd,0,0,"{\"name\":\"%s\",\"dev\":%llu,\"ino\":%llu,\"mode\":%u,\"fs_type\":%lld}",
    name,(unsigned long long)st.st_dev,(unsigned long long)st.st_ino,st.st_mode,(long long)fs.f_type);
  return fd;
}
static bool f4_file(f4_state *s,const char *stage,const char *pass,const char *name,
                   const char *path,long magic,size_t maximum,bool stable,unsigned char **copy,size_t *copied) {
  int fd=f4_aux_open(s,path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK,magic,name);
  if(fd<0)return false;
  unsigned char *bytes=malloc(maximum+1);size_t length=0;bool eof=false;
  if(!bytes)f4_error(s,ENOMEM);
  for(unsigned reads=0;bytes && reads<MAX_CONTEXT_READS && !s->first_error;reads++) {
    if(!f4_context_room(s))break;
    errno=0;ssize_t got=read(fd,bytes+length,maximum+1-length);int error=got<0?errno:0;
    f4_emit(s,"aux-read","aux",fd,got<0?-1:(int)got,error,"{\"name\":\"%s\",\"offset\":%zu}",name,length);
    if(error){f4_error(s,error);break;}
    if(!got){eof=true;break;}
    length+=(size_t)got;
    if(length>maximum){f4_error(s,EOVERFLOW);break;}
  }
  if(!s->first_error && !eof)f4_error(s,EOVERFLOW);
  if(!s->first_error)f4_raw(s,stage,pass,name,fd,bytes,length,stable);
  f4_aux_close(s,&fd,name);
  if(!s->first_error && copy){*copy=bytes;*copied=length;}else free(bytes);
  return !s->first_error;
}
static bool f4_names(f4_state *s,const char *stage,const char *pass,const char *name,
                    const char *path,long magic) {
  int fd=f4_aux_open(s,path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK,magic,name);
  if(fd<0)return false;
  DIR *directory=fdopendir(fd);
  if(!directory){f4_error(s,errno);f4_aux_close(s,&fd,name);return false;}
  char names[128][256];size_t count=0;
  while(!s->first_error) {
    if(!f4_context_room(s))break;
    errno=0;struct dirent *entry=readdir(directory);
    if(!entry){if(errno)f4_error(s,errno);break;}
    if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
    size_t n=strlen(entry->d_name);
    if(!n || n>=sizeof(names[0]) || count>=128){f4_error(s,EOVERFLOW);break;}
    memcpy(names[count++],entry->d_name,n+1);
  }
  for(size_t i=0;i<count;i++)for(size_t j=i+1;j<count;j++)if(strcmp(names[i],names[j])>0){
    char temporary[256];memcpy(temporary,names[i],sizeof(temporary));memcpy(names[i],names[j],sizeof(temporary));memcpy(names[j],temporary,sizeof(temporary));
  }
  unsigned char raw[32768];size_t length=0;
  for(size_t i=0;i<count;i++){size_t n=strlen(names[i])+1;memcpy(raw+length,names[i],n);length+=n;}
  if(!s->first_error)f4_emit(s,"enumeration","aux",fd,0,0,"{\"name\":\"%s\",\"entries\":%zu,\"eof\":true}",name,count);
  if(!s->first_error)f4_raw(s,stage,pass,name,fd,raw,length,true);
  errno=0;int rc=closedir(directory),error=rc?errno:0;s->aux_closes++;
  f4_emit(s,"aux-close","aux",fd,rc,error,"{\"name\":\"%s\",\"ran\":true,\"unknown\":%s}",name,error?"true":"false");
  if(error){s->unknown_aux++;if(!s->cleanup_error)s->cleanup_error=error;f4_error(s,error);}
  return !s->first_error;
}
static bool f4_directory(f4_state *s,const char *stage) {
  if(!f4_metadata(s,&s->dp,"before-members") || !f4_context_room(s))return false;
  int fd=fcntl(s->dp.owner.fd,F_DUPFD_CLOEXEC,3),error=fd<0?errno:0;
  if(fd>=0)s->aux_opens++;
  f4_emit(s,"aux-open","aux",fd,fd<0?-1:0,error,"{\"name\":\"source-members\",\"dup_from\":%d}",s->dp.owner.fd);
  if(error)return f4_error(s,error);
  DIR *dir=fdopendir(fd);
  if(!dir){f4_error(s,errno);f4_aux_close(s,&fd,"source-members");return false;}
  /* 同一 NOATIME open description 的 dup；绝不重新 open /proc/self/fd。 */
  rewinddir(dir);char names[4][256];size_t count=0;
  while(!s->first_error){
    if(!f4_context_room(s))break;
    errno=0;struct dirent *entry=readdir(dir);
    if(!entry){if(errno)f4_error(s,errno);break;}
    if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
    size_t n=strlen(entry->d_name);
    if(n>=256 || count>=4){f4_error(s,ESTALE);break;}
    memcpy(names[count++],entry->d_name,n+1);
  }
  for(size_t i=0;i<count;i++)for(size_t j=i+1;j<count;j++)if(strcmp(names[i],names[j])>0){
    char temporary[256];memcpy(temporary,names[i],256);memcpy(names[i],names[j],256);memcpy(names[j],temporary,256);
  }
  unsigned char raw[1024];size_t length=0;
  for(size_t i=0;i<count;i++){size_t n=strlen(names[i])+1;memcpy(raw+length,names[i],n);length+=n;}
  static const char expected[]="ancestor\0directory\0lost+found\0payload\0";
  if(count!=4 || length!=sizeof(expected)-1 || memcmp(raw,expected,length))f4_error(s,ESTALE);
  if(!s->first_error)f4_emit(s,"enumeration","aux",fd,0,0,"{\"name\":\"source-members\",\"entries\":%zu,\"eof\":true}",count);
  if(!s->first_error)f4_raw(s,stage,"members","source-members",fd,raw,length,true);
  errno=0;int rc=closedir(dir);error=rc?errno:0;s->aux_closes++;
  f4_emit(s,"aux-close","aux",fd,rc,error,"{\"name\":\"source-members\",\"ran\":true,\"unknown\":%s}",error?"true":"false");
  if(error){s->unknown_aux++;if(!s->cleanup_error)s->cleanup_error=error;f4_error(s,error);}
  return !s->first_error && f4_metadata(s,&s->dp,"after-members");
}
static bool f4_extended(f4_state *s,f4_slot *slot,const char *stage) {
  if(!f4_metadata(s,slot,"extended-before"))return false;
  const int fd=slot->owner.fd;const char *kind=slot->owner.directory?"parent":"payload";
  char name[96];struct fsuuid2 uuid={0};
  if(!f4_context_room(s))return false;
  errno=0;int rc=ioctl(fd,FS_IOC_GETFSUUID,&uuid),error=rc?errno:0;
  f4_emit(s,"getter",slot->role,fd,rc,error,"{\"stage\":\"%s\",\"name\":\"uuid\"}",stage);
  if(error || uuid.len!=16)return f4_error(s,error?error:ESTALE);
  /* 在任何 R fsync 之前已实际确认同一固定 filesystem UUID。 */
  unsigned char expected_uuid[16];size_t at=0;
  for(size_t i=0;i<36;){
    if(s->uuid[i]=='-'){i++;continue;}
    unsigned a=s->uuid[i]>='a'?(unsigned)(s->uuid[i]-'a'+10):(unsigned)(s->uuid[i]-'0');
    unsigned b=s->uuid[i+1]>='a'?(unsigned)(s->uuid[i+1]-'a'+10):(unsigned)(s->uuid[i+1]-'0');
    if(at>=sizeof(expected_uuid) || a>15 || b>15)return f4_error(s,EINVAL);
    expected_uuid[at++]=(unsigned char)((a<<4)|b);i+=2;
  }
  if(at!=sizeof(expected_uuid) || memcmp(uuid.uuid,expected_uuid,sizeof(expected_uuid)))return f4_error(s,ESTALE);
  snprintf(name,sizeof(name),"%s.uuid",kind);
  if(!f4_raw(s,stage,slot->role,name,fd,&uuid,sizeof(uuid),true))return false;
  union {max_align_t align;unsigned char raw[sizeof(struct file_handle)+MAX_FID_BYTES];} handle_bytes={0};
  struct file_handle *handle=(struct file_handle *)handle_bytes.raw;handle->handle_bytes=MAX_FID_BYTES;uint64_t mount=0;
  if(!f4_context_room(s))return false;
  errno=0;rc=(int)syscall(SYS_name_to_handle_at,fd,"",handle,&mount,AT_EMPTY_PATH|AT_HANDLE_FID|AT_HANDLE_MNT_ID_UNIQUE);error=rc?errno:0;
  f4_emit(s,"getter",slot->role,fd,rc,error,"{\"stage\":\"%s\",\"name\":\"fid\",\"mount_unique\":%llu}",stage,(unsigned long long)mount);
  uint32_t inode=0;
  if(handle->handle_bytes==8)memcpy(&inode,handle->f_handle,4);
  if(error || handle->handle_bytes!=8 || handle->handle_type!=1 ||
      inode!=slot->owner.initial.st_ino || mount!=slot->owner.unique_mount_id)
    return f4_error(s,error?error:ESTALE);
  snprintf(name,sizeof(name),"%s.fid",kind);
  if(!f4_raw(s,stage,slot->role,name,fd,handle_bytes.raw,sizeof(struct file_handle)+handle->handle_bytes,true))return false;
  uint64_t flags=0;if(!f4_context_room(s))return false;
  errno=0;rc=ioctl(fd,FS_IOC_GETFLAGS,&flags);error=rc?errno:0;
  f4_emit(s,"getter",slot->role,fd,rc,error,"{\"stage\":\"%s\",\"name\":\"flags\"}",stage);
  if(error || (flags!=UINT64_C(0x80000) && !(slot->owner.directory && flags==UINT64_C(0x81000))))
    return f4_error(s,error?error:ESTALE);
  snprintf(name,sizeof(name),"%s.flags",kind);if(!f4_raw(s,stage,slot->role,name,fd,&flags,sizeof(flags),true))return false;
  char names[65536];if(!f4_context_room(s))return false;
  errno=0;ssize_t got=flistxattr(fd,names,sizeof(names));error=got<0?errno:0;
  f4_emit(s,"getter",slot->role,fd,got<0?-1:(int)got,error,"{\"stage\":\"%s\",\"name\":\"xattr-names\"}",stage);
  static const char attr[]="user.boardroom-source-preservation";
  if(error || got!=(ssize_t)sizeof(attr) || memcmp(names,attr,sizeof(attr)))return f4_error(s,error?error:ESTALE);
  snprintf(name,sizeof(name),"%s.xattr-names",kind);if(!f4_raw(s,stage,slot->role,name,fd,names,(size_t)got,true))return false;
  unsigned char value[16384];if(!f4_context_room(s))return false;
  errno=0;got=fgetxattr(fd,attr,value,sizeof(value));error=got<0?errno:0;
  f4_emit(s,"getter",slot->role,fd,got<0?-1:(int)got,error,"{\"stage\":\"%s\",\"name\":\"xattr-value\"}",stage);
  if(error || got!=13 || memcmp(value,"owned-fixture",13))return f4_error(s,error?error:ESTALE);
  snprintf(name,sizeof(name),"%s.xattr-value",kind);if(!f4_raw(s,stage,slot->role,name,fd,value,(size_t)got,true))return false;
  if(!f4_context_room(s))return false;
  errno=0;got=flistxattr(fd,names,sizeof(names));error=got<0?errno:0;
  f4_emit(s,"getter",slot->role,fd,got<0?-1:(int)got,error,"{\"stage\":\"%s\",\"name\":\"xattr-names-after\"}",stage);
  if(error || got!=(ssize_t)sizeof(attr) || memcmp(names,attr,sizeof(attr)))return f4_error(s,error?error:ESTALE);
  snprintf(name,sizeof(name),"%s.xattr-names-after",kind);if(!f4_raw(s,stage,slot->role,name,fd,names,(size_t)got,true))return false;
  return f4_metadata(s,slot,"extended-after");
}

static bool f4_source_configuration(f4_state *s,const char *stage,const char *pass,int source,int carrier) {
  const char *source_role=!strcmp(stage,"after-v")?"V":"M",*carrier_role=!strcmp(stage,"tail")?"A":"Dp";
  const struct stat *carrier_initial=s->m.owner.tail?&s->m.owner.parent_initial:&s->dp.owner.initial;
  if(!f4_metadata_fd(s,carrier_role,carrier,true,carrier_initial,s->m.owner.legacy_mount_id,
                      s->m.owner.unique_mount_id,"configuration-before"))return false;
  struct stat source_stat={0},parent_stat={0},path_stat={0};struct statfs source_fs={0},parent_fs={0};
  uint64_t legacy=0,unique=0,pl=0,pu=0;
  if(!f4_context_room(s) || fstat(source,&source_stat) || !f4_context_room(s) || fstat(carrier,&parent_stat) ||
      !f4_context_room(s) || fstatat(carrier,"payload",&path_stat,AT_SYMLINK_NOFOLLOW) ||
      !f4_context_room(s) || fstatfs(source,&source_fs) || !f4_context_room(s) || fstatfs(carrier,&parent_fs))
    return f4_error(s,errno);
  if(!same_metadata(&source_stat,&s->m.owner.initial) || !same_metadata(&source_stat,&path_stat) ||
      !same_metadata(&parent_stat,carrier_initial) || source_fs.f_type!=EXT4_SUPER_MAGIC || parent_fs.f_type!=EXT4_SUPER_MAGIC ||
      !mount_pair(source,&source_stat,&legacy,&unique) || !mount_pair(carrier,&parent_stat,&pl,&pu) ||
      legacy!=pl || unique!=pu || legacy!=s->m.owner.legacy_mount_id || unique!=s->m.owner.unique_mount_id)
    return f4_error(s,ESTALE);
  f4_emit(s,"source-path",source_role,source,0,0,"{\"stage\":\"%s\",\"pass\":\"%s\",\"carrier_fd\":%d,"
    "\"source_ino\":%llu,\"parent_ino\":%llu,\"dev\":%llu,\"mount_id\":%llu,\"mount_unique\":%llu}",
    stage,pass,carrier,(unsigned long long)source_stat.st_ino,(unsigned long long)parent_stat.st_ino,
    (unsigned long long)source_stat.st_dev,(unsigned long long)legacy,(unsigned long long)unique);
  struct statx sx[2]={{0}};
  for(unsigned i=0;i<2;i++){
    if(!f4_context_room(s))return false;
    errno=0;int rc=(int)syscall(SYS_statx,source,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,
      STATX_BASIC_STATS|STATX_BTIME|(i?STATX_MNT_ID_UNIQUE:STATX_MNT_ID),&sx[i]);int error=rc?errno:0;
    f4_emit(s,"configuration",source_role,source,rc,error,"{\"stage\":\"%s\",\"pass\":\"%s\",\"name\":\"statx-%s\"}",stage,pass,i?"unique":"legacy");
    if(error)return f4_error(s,error);
    if(sx[i].stx_ino!=source_stat.st_ino || sx[i].stx_mnt_id!=(i?unique:legacy))return f4_error(s,ESTALE);
    if(!f4_raw(s,stage,pass,i?"source.statx-unique":"source.statx-legacy",source,&sx[i],sizeof(sx[i]),true))return false;
  }
  struct p3_tune tune={0};if(!f4_context_room(s))return false;
  errno=0;int rc=ioctl(carrier,P3_GET_TUNE,&tune),error=rc?errno:0;
  f4_emit(s,"configuration",carrier_role,carrier,rc,error,"{\"stage\":\"%s\",\"pass\":\"%s\",\"name\":\"get-tune\"}",stage,pass);
  if(error)return f4_error(s,error);
  if(!f4_raw(s,stage,pass,"filesystem.tune",carrier,&tune,sizeof(tune),true))return false;
  struct p3_mnt_req request={.size=sizeof(request),.mnt_id=unique,.param=59};
  unsigned char mount_raw[16384]={0};if(!f4_context_room(s))return false;
  errno=0;rc=(int)syscall(SYS_statmount,&request,mount_raw,sizeof(mount_raw),0);error=rc?errno:0;
  f4_emit(s,"configuration",source_role,source,rc,error,"{\"stage\":\"%s\",\"pass\":\"%s\",\"name\":\"statmount\"}",stage,pass);
  if(error)return f4_error(s,error);
  struct p3_statmount *mount=(struct p3_statmount *)mount_raw;
  if(mount->size<512 || mount->size>sizeof(mount_raw) || mount->mnt_id!=unique || mount->mnt_id_old!=legacy)
    return f4_error(s,ESTALE);
  return f4_raw(s,stage,pass,"source.statmount-request",source,&request,sizeof(request),true) &&
    f4_raw(s,stage,pass,"source.statmount",source,mount_raw,mount->size,true) &&
    f4_metadata_fd(s,carrier_role,carrier,true,carrier_initial,s->m.owner.legacy_mount_id,
                    s->m.owner.unique_mount_id,"configuration-after");
}

static bool f4_namespaces(f4_state *s,const char *stage,const char *pass) {
  static const char *const leaves[]={"pid","mnt","user"};
  for(size_t i=0;i<3;i++){
    char path[128],name[64];snprintf(path,sizeof(path),"/proc/%ld/task/%ld/ns/%s",(long)getpid(),(long)syscall(SYS_gettid),leaves[i]);
    snprintf(name,sizeof(name),"namespace.%s",leaves[i]);
    /* 唯一显式允许的 proc magic-link 跟随：本 child 的 namespace FD。 */
    int fd=f4_aux_open(s,path,O_RDONLY,NSFS_MAGIC,name);if(fd<0)return false;
    char raw[128];if(!f4_context_room(s)){f4_aux_close(s,&fd,name);return false;}
    errno=0;ssize_t n=readlink(path,raw,sizeof(raw));int error=n<0?errno:0;
    f4_emit(s,"namespace-link","aux",fd,n<0?-1:(int)n,error,"{\"stage\":\"%s\",\"pass\":\"%s\",\"name\":\"%s\"}",stage,pass,name);
    if(error || n<=0 || (size_t)n>=sizeof(raw))f4_error(s,error?error:EOVERFLOW);
    if(!s->first_error)f4_raw(s,stage,pass,name,fd,raw,(size_t)n,true);
    f4_aux_close(s,&fd,name);if(s->first_error)return false;
  }
  return true;
}
static bool f4_device(f4_state *s,const char *stage,const char *pass,char sysname[64]) {
  char link[128],resolved[PATH_MAX],hex[PATH_MAX*2+1];
  snprintf(link,sizeof(link),"/sys/dev/block/%u:%u",major(s->device),minor(s->device));
  if(!f4_context_room(s) || !realpath(link,resolved))return f4_error(s,errno);
  const char *name=strrchr(resolved,'/');
  static const char prefix[]="/sys/devices/virtual/block/dm-";
  if(strncmp(resolved,prefix,sizeof(prefix)-1) || !name || strlen(name+1)>=64)return f4_error(s,ESTALE);
  strcpy(sysname,name+1);f4_hex(resolved,strlen(resolved),hex);
  if(!f4_raw(s,stage,pass,"device.path",-1,resolved,strlen(resolved),true))return false;
  char expected_name[64]="br-f3-",expected_uuid[80],path[256];size_t length=strlen(expected_name);
  for(size_t i=0;i<36;i++)if(s->run_id[i]!='-')expected_name[length++]=s->run_id[i];
  expected_name[length++]='\n';expected_name[length]='\0';
  snprintf(expected_uuid,sizeof(expected_uuid),"boardroom-f3-dm:%s\n",s->run_id);
  static const char *const dm_attributes[]={"name","uuid"};
  for(unsigned i=0;i<2;i++){
    const char *expected=i?expected_uuid:expected_name;unsigned char *value=NULL;size_t n=0;
    snprintf(path,sizeof(path),"/sys/devices/virtual/block/%s/dm/%s",sysname,dm_attributes[i]);
    if(!f4_file(s,stage,pass,i?"device.dm-uuid":"device.dm-name",path,SYSFS_MAGIC,256,true,&value,&n))return false;
    bool same=n==strlen(expected) && !memcmp(value,expected,n);free(value);
    if(!same)return f4_error(s,ESTALE);
  }
  const char *nodes[]={sysname,"ram0"};
  /* 固定表有独立 data section，避免编译器把自动数组的匿名常量池与
   * 原 NAPI initializer 表合并，从而意外拉入本 target 不调用的绑定。 */
  static const char *const attributes[]={"dev","uevent","size","ro","diskseq"};
  for(unsigned i=0;i<2;i++){
    char base[PATH_MAX];snprintf(base,sizeof(base),"/sys/devices/virtual/block/%s",nodes[i]);
    for(unsigned j=0;j<5;j++){
      char path[PATH_MAX],key[96];int length=snprintf(path,sizeof(path),"%s/%s",base,attributes[j]);
      if(length<0 || (size_t)length>=sizeof(path))return f4_error(s,EOVERFLOW);
      snprintf(key,sizeof(key),"graph.%s.%s",i?"backing":"source",attributes[j]);
      if(!f4_file(s,stage,pass,key,path,SYSFS_MAGIC,4096,true,NULL,NULL))return false;
    }
    static const char *const sets[]={"slaves","holders",""};
    for(unsigned j=0;j<3;j++){
      char path[PATH_MAX],key[96];int length=snprintf(path,sizeof(path),"%s/%s",base,sets[j]);
      if(length<0 || (size_t)length>=sizeof(path))return f4_error(s,EOVERFLOW);
      snprintf(key,sizeof(key),"graph.%s.%s",i?"backing":"source",j==2?"entries":sets[j]);
      if(!f4_names(s,stage,pass,key,path,SYSFS_MAGIC))return false;
    }
    char path[PATH_MAX];int length=snprintf(path,sizeof(path),"%s/partition",base);
    if(length<0 || (size_t)length>=sizeof(path) || !f4_context_room(s))return f4_error(s,EOVERFLOW);
    struct stat st;errno=0;int rc=lstat(path,&st),error=rc?errno:0;
    f4_emit(s,"absence","aux",-1,rc,error,"{\"stage\":\"%s\",\"pass\":\"%s\",\"name\":\"graph.%s.partition\"}",stage,pass,i?"backing":"source");
    if(rc!=-1 || error!=ENOENT)return f4_error(s,ESTALE);
  }
  return true;
}
static bool f4_health(f4_state *s,const char *stage,const char *pass,const char *sysname) {
  char path[256];static const char *const proc_names[]={"options","mb_groups"};
  for(unsigned i=0;i<2;i++){
    snprintf(path,sizeof(path),"/proc/fs/ext4/%s/%s",sysname,proc_names[i]);
    if(!f4_file(s,stage,pass,proc_names[i],path,PROC_SUPER_MAGIC,16384,true,NULL,NULL))return false;
  }
  snprintf(path,sizeof(path),"/sys/fs/ext4/%s/journal_task",sysname);
  unsigned char *task=NULL;size_t length=0;
  if(!f4_file(s,stage,pass,"journal-task",path,SYSFS_MAGIC,4096,true,&task,&length))return false;
  uint64_t pid=0;bool valid=length>=2 && length<=11 && task[length-1]=='\n';
  for(size_t i=0;valid && i+1<length;i++){
    if(task[i]<'0'||task[i]>'9'||pid>((uint64_t)INT_MAX-(task[i]-'0'))/10)valid=false;
    else pid=pid*10+(task[i]-'0');
  }
  free(task);if(!valid || !pid)return f4_error(s,ESTALE);
  if(!f4_context_room(s))return false;
  errno=0;long priority=syscall(SYS_ioprio_get,1,(int)pid);int error=priority<0?errno:0;
  f4_emit(s,"ioprio","aux",-1,priority<0?-1:(int)priority,error,"{\"stage\":\"%s\",\"pass\":\"%s\",\"which\":1,\"who\":%llu}",stage,pass,(unsigned long long)pid);
  if(error)return f4_error(s,error);
  static const char *health[]={"errors_count","first_error_errcode","last_error_errcode","first_error_ino","last_error_ino",
    "first_error_block","last_error_block","first_error_line","last_error_line","first_error_time","last_error_time","first_error_func","last_error_func"};
  for(unsigned i=0;i<13;i++){
    snprintf(path,sizeof(path),"/sys/fs/ext4/%s/%s",sysname,health[i]);
    unsigned char *value=NULL;size_t n=0;
    if(!f4_file(s,stage,pass,health[i],path,SYSFS_MAGIC,4096,true,&value,&n))return false;
    bool zero=i<11?n==2&&!memcmp(value,"0\n",2):n==1&&value[0]=='\n';free(value);
    if(!zero)return f4_error(s,ESTALE);
  }
  return true;
}
static bool f4_environment(f4_state *s,const char *stage,int source,int carrier) {
  if(!f4_charge(s))return false;
  const char *role=!strcmp(stage,"after-v")?"V":"M";
  f4_emit(s,"environment-begin",role,source,0,0,"{\"stage\":\"%s\",\"carrier_fd\":%d}",stage,carrier);
  for(unsigned round=0;round<2;round++){
    const char *pass=round?"after":"before";
    if(getuid()!=1000 || geteuid()!=1000 || getgid()!=1000 || getegid()!=1000 || getppid()!=1 ||
        getgroups(0,NULL)!=0 || prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)!=1)return f4_error(s,EPERM);
    f4_emit(s,"credentials","aux",-1,0,0,"{\"stage\":\"%s\",\"pass\":\"%s\",\"uid\":1000,\"gid\":1000,\"groups\":0,\"no_new_privs\":1,\"ppid\":1,\"tid\":%ld}",stage,pass,(long)syscall(SYS_gettid));
    if(!f4_source_configuration(s,stage,pass,source,carrier) || !f4_namespaces(s,stage,pass))return false;
    struct utsname name={0};if(!f4_context_room(s) || uname(&name))return f4_error(s,errno);
    if(!f4_raw(s,stage,pass,"uname",-1,&name,sizeof(name),true))return false;
    char path[128];snprintf(path,sizeof(path),"/proc/%ld/task/%ld/status",(long)getpid(),(long)syscall(SYS_gettid));
    if(!f4_file(s,stage,pass,"thread-status",path,PROC_SUPER_MAGIC,65536,false,NULL,NULL))return false;
    snprintf(path,sizeof(path),"/proc/%ld/stat",(long)getpid());
    if(!f4_file(s,stage,pass,"process-stat",path,PROC_SUPER_MAGIC,8192,false,NULL,NULL))return false;
    snprintf(path,sizeof(path),"/proc/%ld/task/%ld/mountinfo",(long)getpid(),(long)syscall(SYS_gettid));
    if(!f4_file(s,stage,pass,"mountinfo",path,PROC_SUPER_MAGIC,1048576,true,NULL,NULL) ||
       !f4_file(s,stage,pass,"boot-id","/proc/sys/kernel/random/boot_id",PROC_SUPER_MAGIC,4096,true,NULL,NULL) ||
       !f4_file(s,stage,pass,"cmdline","/proc/cmdline",PROC_SUPER_MAGIC,16384,true,NULL,NULL) ||
       !f4_file(s,stage,pass,"kernel-notes","/sys/kernel/notes",SYSFS_MAGIC,1048576,true,NULL,NULL))return false;
    f4_emit(s,"unsupported","aux",-1,0,0,"{\"stage\":\"%s\",\"pass\":\"%s\",\"name\":\"kernel-config\",\"reason\":\"unsupported\"}",stage,pass);
    char sysname[64];if(!f4_device(s,stage,pass,sysname) || !f4_health(s,stage,pass,sysname))return false;
  }
  if(!f4_source_configuration(s,stage,"final",source,carrier) || !f4_metadata(s,&s->m,"environment-after"))return false;
  f4_emit(s,"environment-end",role,source,0,0,"{\"stage\":\"%s\",\"carrier_fd\":%d,\"aux_live\":%u}",stage,carrier,s->aux_opens-s->aux_closes);
  return f4_charge(s);
}
#endif
