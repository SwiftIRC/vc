CXX ?= g++
CXXFLAGS = -std=c++17 -Wall -Wextra -O2 -I..
LDLIBS = -lcrypto
test: test_main.cpp
	$(CXX) $(CXXFLAGS) test_main.cpp -o test_bin $(LDLIBS)
	./test_bin
# Optional: syntax-check the libcurl-guarded path in provision.h. Not part of
# `test` (the host may lack libcurl dev headers); run explicitly when present.
curlcheck:
	@pkg-config --exists libcurl || { echo "libcurl dev headers not found; skipping"; exit 0; }
	$(CXX) $(CXXFLAGS) -DWVC_HAVE_CURL $$(pkg-config --cflags libcurl) -fsyntax-only ../core/provision.h
clean:
	rm -f test_bin
.PHONY: test clean curlcheck
