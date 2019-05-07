/**
 *    Copyright (C) 2018-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#include "mongo/platform/basic.h"

#include <cstdio>
#include <cstdlib>
#include <cxxabi.h>
#include <sstream>

#include <fmt/printf.h>

// #define UNW_LOCAL_ONLY  // shouldn't need this at all
#include <libunwind.h>

#include "mongo/unittest/unittest.h"

namespace mongo {

// Must be a named namespace so the functions we want to unwind through have external linkage.
// Without that, the compiler optimizes them away.
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

    // Check that these function names appear in the trace, in order.
    // There will of course be characters between them but ignore that.
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
