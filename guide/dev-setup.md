# 开发环境配置

> 快速配置参考[一键部署](/guide/quick-start)

**注意**：eBPF 开发**必须**在 Linux 环境下进行（当前验证版本为Linux 6.12.74+deb13+1-amd64），Mac/Windows 用户请使用虚拟机或 WSL2。

验证内核支持：

```bash
# expected not empty
ls -la /sys/kernel/btf/vmlinux
```

## C

Deepsight 的核心优势在于底层 eBPF 探针的高效与无侵入性，在 Deepsight 的架构中，Probe 端包含两部分代码：即内核态 eBPF 程序 (C 语言)和用户态加载器 (Go 语言)。因此需要配置 C + eBPF，且支持 go 和 CO-RE 特性，主体配置顺序如下：

1. C 工具链
2. eBPF库
3. bpftool工具

> [!NOTE]
>
> - C探针Go 加载：LLVM/Clang 编译器能最适配地将 C 代码编译为符合标准的 BPF 字节码（`.o` 文件），而使用 Go 作为用户态控制面（借助 `cilium/ebpf` 库），可以彻底摆脱对 CGO 的依赖，将 Deepsight Probe 编译出一个极其干净、没有外部 C 动态库依赖的单一二进制文件，极大降低在生产环境的部署难度
> - BTF 与 CO-RE 技术
>   - 传统方式：eBPF 程序与内核版本强绑定，必须在目标机器上带上 Linux 源码头文件编译安装
>   - CO-RE：现代 Linux 内核自带了 BTF，类似内核的“结构体说明书”，基于此可以使用 bpftool 生成一个万能的 `vmlinux.h` 头文件
>   - 使用`vmlinux.h`编译，Deepsight Probe 就可以在几乎所有现代 Linux 发行版上直接运行

### C 工具链

1. 基础 C 环境：`build-essential` 包含`g++` 、`gcc` 、`make` 和一些基础 C 库

    ```bash
    sudo apt install build-essential
    ```

2. Clang/LLVM：eBPF适配最成熟、最权威的编译链，根据 [官方教程](https://apt.llvm.org/)，选择包管理器或脚本安装

    - 包管理器安装需根据操作系统添加 APT 源
    - `clangd` 负责实时解析，`clang-tidy` 负责静态检查，`clang-format` 负责格式化
    - 脚本安装会导致工具后缀包含版本号码，需要 `ln` 建立软链接，因此推荐通过包管理器安装（确保版本大于等于15即可）
    - `llvm.sh` 脚本默认同时安装版本对齐的最新 Clang 前端和 LLVM 后端；其余仍需通过包管理器安装，注意与`clang`版本匹配

    ```bash
    sudo apt install -y clang llvm-dev clangd clang-format clang-tidy
    ```


### eBPF库

1. 基本头文件：项目针对 CO-RE 特性的开发，**实际并不依赖头文件**，而是提取 `vmlinux.h` 开发；引入头文件作为兜底排查

    ```bash
    sudo apt install -y linux-headers-$(uname -r)
    ```

2. `libbpf`：通过 Git Submodule 引入

   ```bash
   # execute under Deepsight root dir
   mkdir -p 3rd/
   git submodule add https://github.com/libbpf/libbpf.git 3rd/libbpf
   ```

### bpftool工具

`bpftool` 用于排查 eBPF 问题和生成 CO-RE 头文件，为了确保全特性支持，参考 [官方说明](https://github.com/libbpf/bpftool) 手动编译方式安装。

1. 安装全特性依赖

    ```bash
    sudo apt install -y pkg-config libelf-dev zlib1g-dev libssl-dev libcap-dev binutils-dev
    ```

2. 轻量化拉取源码最近的 commit，含`libbpf` Git Submodule

    ```bash
    # temp code
    cd /tmp/
    git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/libbpf/bpftool.git
    ```

3. 编译并安装

    ```bash
    cd /tmp/bpftool/src && sudo make install
    ```

4. 可选 man 手册安装

    ```bash
    sudo apt install -y python3-docutils
    cd /tmp/bpftool/docs && sudo make install
    ```

## Go

Probe 端需要通过 gRPC 将高度压缩后的数据实时推送到 Server 端，同时，用户态的 Go 加载器需处理内核态 eBPF 程序，因此需要 Go+Protobuf + gRPC+eBPF 环境。主体配置顺序如下：

1. Go 核心
2. Protobuf 编译器
3. Go 插件：提供 Go 对 protobuf 和 eBPF 的支持

> [!NOTE]
>
> Go 开发环境核心概念
>
> - `PATH`：
>   - 官方核心库 (`/usr/local/go/bin`)：这是 Go SDK 的安装目录，里面装着 `go`、`gofmt` 等官方基础命令
>   - 第三方工具库 (`$(go env GOPATH)/bin`)：`GOPATH` 是 Go 的全局工作区缓存，首次使用 `go install` 下载并编译第三方命令行工具时，Go 会自动创建这个 `bin` 目录并将可执行文件塞进去
> - 依赖管理：Go Modules (`go.mod`)
>   - 旧特性：所有的代码必须塞进一个全局的 `GOPATH/src` 目录里，极其反人类
>   - 新特性：从 Go 1.11 开始，可以在电脑的任意位置新建项目文件夹，执行 `go mod init <模块名>`，生成一个 `go.mod` 文件，第三方依赖包会被统一下载到全局缓存（`GOPATH/pkg/mod`），并在编译时按 `go.mod` 声明的版本进行精准组装
>   - 强烈建议执行 `go env -w GO111MODULE=on` 强制开启，确立开启特性
> - 安装命令：`go get` & `go install`
>   - `go install <包名>`：
>     - 下载源码并编译成可执行文件，放到 `GOPATH/bin` 下，用于在命令行直接敲击使用
>     - 本质上只是从主包编译一个二进制文件，因此撤销 `go install` 是通过移除二进制文件完成的(go本身没有相关的撤销命令)
>   - `go get -tool`：作为项目级`go install`，将二进制代码编译到`GOCACHE` 路径，需 `go mod tidy` 触发
>   - `go get <包名>`：
>     - 下载代码源码到本地缓存，并把记录写进 `go.mod` 账本里，用于在业务代码里 `import` 调用
>     - 撤销时需要移除项目代码中，对于该包的所有引用，然后运行 `go mod tidy`
> - Protubuf
>   - `protoc` 是 C++ 编写的基础编译器，需单独下载配置
>   - 底层的 `protoc` 不懂 Go，需要通过 `go install` 安装 `protoc-gen-go` (基础数据结构) 和 `protoc-gen-go-grpc` (通信接口) 两个插件来辅助翻译，缺一不可

### Go 核心

1. 前往 [Go 官方下载页](https://go.dev/dl/) 下载最新版本压缩包 👉 [国内镜像源](https://golang.google.cn/dl/)
2. 参考 [官方安装教程](https://go.dev/doc/install) 解压缩并添加环境变量，注意 `sudo` 权限

    ```bash
    # remove legancy version
    sudo rm -rf /usr/local/go
    # install latest version
    sudo tar -C /usr/local -xzf go1.26.2.linux-amd64.tar.gz

    # path added to env
    export PATH=$PATH:/usr/local/go/bin
    export PATH="$PATH:$(go env GOPATH)/bin"
    ```

3. 启用 Go 模块特性，并按需配置国内镜像源

    ```bash
    go env -w GO111MODULE=on
    go env -w GOPROXY=https://goproxy.cn,direct
    # for ali
    # go env -w GOPROXY=https://mirrors.aliyun.com/goproxy/,direct
    ```

### Protocbuf 编译器

由于不涉及 C++ 的业务代码，无需担心版本严格绑定问题，直接选择 Active Support (大于 `33.x` 系列) 的主线版本，参考 [官方下载教程](https://protobuf.dev/installation/#binary-install) 中 “Install Pre-compiled Binaries” 即可。

1. 前往 [Protobuf 仓库](https://github.com/protocolbuffers/protobuf/releases/latest) 下载最新压缩包
2. 解压到指定目录并添加环境变量

    ```bash
    unzip protoc-34.1-linux-x86_64.zip -d $HOME/.local
    
    #path added to env
    export PATH="$PATH:$HOME/.local/bin"
    ```

### Go 插件

> [!NOTE]
>
> - [bpf2go](https://github.com/cilium/ebpf/tree/main/cmd/bpf2go)：用于自动调用 Clang 编译 C 代码，并将文件打包成 Go 代码里的变量，屏蔽底层复杂逻辑
>   - Probe 用户态 Go 程序与内核态 C 探针需要一个良好的桥梁，需确保在编译期时将 C 编译器生成的 .o 二进制文件，无缝且优雅地集成到 Go 语言的工程树中；运行期 Go 程序启动后，通过底层的 Linux 系统调用，将 eBPF 程序安全挂载到指定的内核钩子上，并维持高速的数据流转
>   - `cilium/ebpf` 框架中的`bpf2go`插件，直接在 Go 语言内部，使用纯净的 Go 代码封装了 Linux 底层所有的 bpf() 系统调用，从而不依赖目标机器上的任何 C 语言动态库，能够交付产出干净、独立执行的单文件二进制程序
> - [gRPC-go](https://grpc.io/docs/languages/go/quickstart/#prerequisites) ：gRPC Go 支持插件，官方教程中，使用 `go install` 将 `protoc-gen-go` 和`protoc-gen-go-grpc` 安装到全局路径；如果调整为 `go get -tool`，`Protoc`作为 C++ 编写的独立编译器，并不知道 Go 语言的 tool 新机制，无法寻找到这两个二进制文件，因此需要在 Makefile 中通过 `go build` 包装编译到项目路径中

进入项目文件夹 `Deepsight` 根目录

1. 初始化

    ```bash
    go mod init github.com/riyueshan/deepsight
    # for local use and do not share with others
    # go mod init deepsight
    ```

2. 安装 eBPF 和 gRPC 支持插件

    ```bash
    go get -tool github.com/cilium/ebpf/cmd/bpf2go
    go get -tool google.golang.org/protobuf/cmd/protoc-gen-go@latest
    go get -tool google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
    ```

3. 拉取 gRPC 和 Protobuf 源码依赖

    ```bash
    go get google.golang.org/grpc@latest
    go get google.golang.org/protobuf@latest
    ```

4. 触发依赖配置

    ```bash
    go mod tidy
    ```

## 项目初始化

1. 生成 `vmlinux.h`：利用系统自带的 BTF 信息生成所有内核数据结构的 C 定义头文件，这是所有 CO-RE 程序编译的前提

    ```bash
    sudo bpftool btf dump file /sys/kernel/btf/vmlinux format c > probe/bpf/vmlinux.h
    ```

2. clangd 配置：`.clangd` 默认解析路径不是很灵活，考虑利用当前终端的 `$PWD` 动态生成配置文件

    ```bash
    cat <<EOF > .clangd
    CompileFlags:
      Add:
        - "-target"
        - "bpf"
        - "-D__TARGET_ARCH_x86"
        - "-I${PWD}/probe/bpf"
        - "-I${PWD}/3rd/libbpf/src"
    
    If:
      PathMatch: probe/bpf/.*\.c
    EOF
    ```
