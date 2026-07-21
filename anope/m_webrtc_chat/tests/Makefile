CXX ?= g++
CXXFLAGS = -std=c++17 -Wall -Wextra -O2 -I..
LDLIBS = -lcrypto
test: test_main.cpp
	$(CXX) $(CXXFLAGS) test_main.cpp -o test_bin $(LDLIBS)
	./test_bin
clean:
	rm -f test_bin
.PHONY: test clean
