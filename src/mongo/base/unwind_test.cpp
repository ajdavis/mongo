#include "mongo/platform/basic.h"

#include <cstdio>
#include <cstdlib>
#include <cxxabi.h>
#include <sstream>

#include <fmt/printf.h>

#define UNW_LOCAL_ONLY
#include <libunwind.h>

#include "mongo/unittest/unittest.h"

namespace mongo {

namespace unwind_test_detail {

struct Context {
    std::string* s;
};

void trace(std::ostringstream& oss) {
    unw_cursor_t cursor;
    unw_context_t context;

    // Initialize cursor to current frame for local unwinding.
    unw_getcontext(&context);
    unw_init_local(&cursor, &context);
    // Unwind frames one by one, going up the frame stack.
    while (unw_step(&cursor) > 0) {
        unw_word_t offset, pc;
        unw_get_reg(&cursor, UNW_REG_IP, &pc);
        if (pc == 0) {
            break;
        }
        oss << fmt::sprintf("0x%lx:", pc);
        char sym[256];
        char* name = sym;
        int err;
        if ((err = unw_get_proc_name(&cursor, sym, sizeof(sym), &offset)) != 0) {
            oss << fmt::sprintf(" -- error: unable to obtain symbol name for this frame: %d\n",
                                err);
            continue;
        }
        name = sym;
        int status;
        char* demangled_name;
        if ((demangled_name = abi::__cxa_demangle(sym, nullptr, nullptr, &status))) {
            name = demangled_name;
        }
        oss << fmt::sprintf(" (%s+0x%lx)\n", name, offset);
        if (name != sym) {
            free(name);  // allocated by abi::__cxa_demangle
        }
    }
}

template <int N>
struct F {
    __attribute__((noinline)) void operator()(Context& ctx) const;
};

template <int N>
void F<N>::operator()(Context& ctx) const {
    asm volatile("");  // prevent inlining
    F<N - 1>{}(ctx);
}

template <>
void F<0>::operator()(Context& ctx) const {
    asm volatile("");  // prevent inlining
    std::ostringstream oss;
    trace(oss);
    *ctx.s = oss.str();
}

template <size_t N>
void f(Context& ctx) {
    F<N>{}(ctx);
}

TEST(Unwind, Demangled) {
    std::string s;
    Context ctx{&s};
    f<20>(ctx);
    std::cerr << "backtrace: [[[\n" << s << "]]]\n";
    const std::string frames[] = {
        "mongo::unwind_test_detail::F<2>::operator()(mongo::unwind_test_detail::Context&)",   //
        "mongo::unwind_test_detail::F<20>::operator()(mongo::unwind_test_detail::Context&)",  //
        "mongo::unittest::Test::run()",                                                       //
        "main",                                                                               //
    };
    size_t pos = 0;
    for (const auto& expected : frames) {
        pos = s.find(expected, pos);
        ASSERT_NE(pos, s.npos) << s;
    }
}

}  // namespace unwind_test_detail

}  // namespace mongo
